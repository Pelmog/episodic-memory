# Shared stateless HTTP service

One long-lived `node dist/mcp-server.js --http` process serves the `search` and
`read` tools to every Claude Code and Codex session, instead of one stdio server
(plus its embedding model) per session. It speaks MCP 2026-07-28 with the
official SDK (`@modelcontextprotocol/server` 2.3.1); 2025 clients get the SDK's
stateless legacy fallback (no session ids, `maxSubscriptions: 0`). The stdio
entrypoint is unchanged and remains the default without `--http`.

Tool names, descriptions, input schemas, annotations and output text are
byte-identical to the stdio server (fixtures in `test/fixtures/mcp-baseline/`).

## Architecture

- **Boundary.** Binds `127.0.0.1` only, default port 8734 (`EPISODIC_MEMORY_HTTP_PORT`).
  `POST /mcp` only. Every request needs `Authorization: Bearer <token>`, read from
  `EPISODIC_MEMORY_HTTP_TOKEN_FILE` (regular file, owned by the current uid,
  mode exactly 0600, at least 32 bytes, no whitespace). Auth runs before the body
  is read. Body limit 1 MiB; at most 16 admitted requests, further ones get 503.
  No health or unauthenticated endpoint.
- **Worker pool.** Tool calls run on `EPISODIC_MEMORY_HTTP_WORKERS` worker threads
  (default 3, range 1-8; `dist/tool-worker.js`). Each worker owns its own
  embedding model (warmed up in the background, bounded at 60 s) and its own
  index connection. A busy pool queues (bounded) and then answers 503.
- **Read-only index.** Workers open the SQLite index read-only and never migrate
  it. Indexing and sync stay with the normal sync/index CLIs and hooks; the
  service never writes the index or the archive.
- **`read` restriction.** The shared `read` tool only opens existing `.jsonl`
  files whose real path (symlinks resolved) is inside the conversation archive
  or a configured transcript source directory. Anything else is an error
  (`src/read-policy.ts`).
- **Deadlines.** Each tool call has a deadline timed from dispatch
  (`EPISODIC_MEMORY_TOOL_DEADLINE_MS`, default 100000). On expiry, client
  cancel or disconnect the worker is retired and replaced (live workers are
  capped at twice the pool size) and the caller gets a tool error.
- **Shutdown.** SIGTERM/SIGINT stop accepting, drain within 10 s and exit 0.
  Ready line on stderr: `episodic-memory HTTP ready on 127.0.0.1:<port> (<n> workers)`.

## Boundaries (what this does NOT do)

- One bearer token = one trust domain: every caller with the token reads the
  same memory. Not multi-tenant.
- Not reachable off-host; no TLS (loopback only).
- No writes through MCP; no indexing, sync or migration in the service.
- `read` cannot reach files outside the archive and transcript directories.
- Existing sessions keep their stdio server until they restart or reconnect;
  nothing is killed. No fleet-wide memory saving is claimed until they do.
- A legacy JSON-RPC batch where one call is rejected busy drops its sibling
  results (read-only tools; retry the batch).
- Claude never stores the token (see below); Codex does, in its 0600 config.

## Local deployment

- Worktree/branch: `~/repos/episodic-memory-v2`, `feat/stateless-http-v2`
- Endpoint `http://127.0.0.1:8734/mcp`; launchd label `com.local.episodic-memory-v2`
- State `~/.local/share/mcp-fleet/episodic-memory/`: `http-token` (0600, never
  commit or print), `headers-helper.sh` (0700), `service.log` (0600),
  `switch-record.json` (0600)
- Plist `~/Library/LaunchAgents/com.local.episodic-memory-v2.plist`
  (`RunAtLoad`, `KeepAlive`, `ThrottleInterval` 5)
- Runtime: the pinned Node (`~/.local/share/episodic-memory/runtime/node-v24.21.0-darwin-arm64`)
  is first on `PATH` for every command, so native modules match.
- Evidence and original-file backups (0600): `~/repos/mcp-fleet-v2/evidence/<date>-episodic/`

## Commands

All via `python3 scripts/manage-local-service.py <command>`. None prints the token.

| Command | What it does |
|---|---|
| `install` | Checks the pinned Node, creates the state dir (0700), token (created once, never overwritten), log and headers helper; runs `npm install --no-package-lock` (no lockfile exists), `npm run build`, `npm test`; native check (better-sqlite3 + sqlite-vec); copies the embedding model cache from the registered plugin install if absent and validates it by an offline load; writes the plist, `launchctl bootout` (ignored) and `bootstrap gui/<uid>`; then probes (waits up to 90 s). |
| `probe` | Runs `scripts/probe-live.mjs` against the service with a modern and a legacy client: `tools/list` must equal the baseline catalog (name, description, schema, annotations), then a `search` and a `read` of the first hit (lines 1-5). Prints only counts, latencies and `ok`/`fail`. |
| `switch-clients [--claude-mode plugin-manifest\|user-scope]` | Requires a passing probe. Preflight reads and parses every target and checks each is the expected pre-switch form (or already switched, so a re-run is a no-op); writes the 0600 record and backups before editing; edits are atomic and any failure restores the files already edited and marks the record `active: false` with `failed`. |
| `rollback` | Restores recorded entries; see below. |

`switch-clients` targets:

- Codex `~/.codex/config.toml`: only the `[mcp_servers.episodic-memory]` table is
  replaced with `url` + `http_headers = { Authorization = "Bearer <token>" }`,
  keeping `startup_timeout_sec`/`tool_timeout_sec`. Codex has no header helper,
  so the token lives in that 0600 file (as the Outlook entry already does).
- Claude, `plugin-manifest` (default): `.mcp.json` and `.claude-plugin/plugin.json`
  of the registered plugin directory (`installed_plugins.json`, exactly one
  user-scope entry) get `{"type":"http","url":...,"headersHelper":"<state>/headers-helper.sh"}`.
  The helper prints `{"Authorization":"Bearer <token>"}` from the token file, so
  the token is never written into any Claude file.
- Claude, `user-scope` (fallback): the same entry under `mcpServers` in
  `~/.claude.json`; the plugin manifest entries are removed, and
  `agents/search-conversations.md` tool names are rewritten from
  `mcp__plugin_episodic-memory_episodic-memory__` to `mcp__episodic-memory__`.
  All of it is recorded and rolled back.

The plugin patcher re-applies the switch to newly installed plugin versions
while the record says `active: true`, and adds those files to the record.

## If the service is down at Claude session start

Claude connects HTTP servers once at session start. If the service was not up,
the `episodic-memory` tools are missing for that session. Start/restart it
(`launchctl kickstart -k gui/$(id -u)/com.local.episodic-memory-v2`), then run
`/mcp` in the session and reconnect `episodic-memory`; no restart is needed.
Codex picks the service up on its next session. Check
`~/.local/share/mcp-fleet/episodic-memory/service.log` if it keeps failing.

## Claude client mechanism

**Decision: `plugin-manifest`.** A Claude Code plugin can declare the server as
`type: http` with a `headersHelper`; verified empirically with `scripts/claude-plugin-http-probe.sh`
on Claude Code **2.1.296** (2026-10-14).

Manifest shape (`.claude-plugin/plugin.json`):

```json
{"name":"em-http-probe","version":"0.0.1","mcpServers":{"episodic-memory":
  {"type":"http","url":"http://127.0.0.1:<port>/mcp","headersHelper":"<tmp>/helper.sh"}}}
```

The helper prints `{"Authorization":"Bearer <token>"}` reading the token from a 0600 file
(token never in argv or Claude's env). Tool name: `mcp__plugin_<plugin>_episodic-memory__search`.

Evidence (temp service on a free port, isolated fixture index, scratch token; token never printed):

- Pass criteria (hardened): positive needs helper invoked at least once AND result exactly 3 (the fixture count); negative needs helper invoked at least once AND `HEADERS_HELPER_AUTH_REJECTED`/401 in Claude's output; a flag combination that runs zero cases exits 2. Runs use `--no-session-persistence` so no transcript is written under `~/.claude`.
- Positive: `claude -p --plugin-dir=<tmp>/em-http-probe --output-format json --allowedTools=mcp__plugin_em-http-probe_episodic-memory__search "<call search, query 'zebra widget cache', response_format json, print count>"`
  gave exit 0, `num_turns: 3`, `result: "3"`, helper invoked once.
- Negative control (helper prints a wrong same-length token): exit 0, `num_turns: 1`, result:
  `plugin:em-http-probe:episodic-memory failed to connect (HEADERS_HELPER_AUTH_REJECTED): Server rejected the Authorization header minted by the configured headersHelper (HTTP 401)`; helper invoked 3 times; no tool available.
- Final line: `PASS positive_pass=1 negative_control_pass=1 failures=0 strict=0 live=0`.

Findings and required flags:

- **`--strict-mcp-config` hides plugin MCP servers** (tool absent: "No matching deferred tools found", helper never invoked, run twice). Operator consequence: any headless/scripted `claude` run using `--strict-mcp-config` will not see the plugin's episodic-memory HTTP server. Do not use it; the probe omits it unless `--strict` is passed.
- `--allowedTools` and `--plugin-dir` are variadic and swallow the trailing prompt; use the `--flag=value` form (or put the prompt first).
- Re-run any time against the live service: `scripts/claude-plugin-http-probe.sh --live` (URL `http://127.0.0.1:8734/mcp`, helper `$HOME/.local/share/mcp-fleet/episodic-memory/headers-helper.sh`; positive case only).
- The `user-scope` fallback (remove manifest servers, retarget `agents/search-conversations.md` `tools:` to `mcp__episodic-memory__`) is therefore not needed.
- Patcher integration (Task 9 Step 3) is done separately by the controller.

## Rollback

`python3 scripts/manage-local-service.py rollback`

For every recorded file (including plugin versions added by the patcher):
if the current episodic entry equals the recorded switched entry it is
restored to the original atomically and unrelated content is kept; if it already
equals the original it is skipped; otherwise rollback stops with a `DriftError`
naming the file and changes nothing. Drift is checked for all files before any
is written. On success the record becomes `active: false` so the patcher stops
re-applying. The service is left running for connected HTTP clients; once they
have reconnected to stdio, stop it with
`launchctl bootout gui/$(id -u)/com.local.episodic-memory-v2`.
Original files are also backed up under the evidence directory.

## Tests

`python3 -m unittest scripts/test_manage_local_service.py` (temporary HOME via
`EM_TEST_HOME`; no launchctl, npm or real config is touched) and `npm test`.
