# Shared stateless HTTP service

One long-lived `node dist/mcp-server.js --http` process serves the `search` and
`read` tools to every Claude Code and Codex session, instead of one stdio server
(plus its embedding model) per session. It speaks MCP 2026-07-28 with the
official SDK (`@modelcontextprotocol/server` 2.3.1). The stdio entrypoint is
unchanged and remains the default without `--http`.

Two protocol legs, both stateless (no session ids):

- **Modern (2026-07-28) clients** go through the SDK's `createMcpHandler` with
  `legacy: 'reject'` and `maxSubscriptions: 0`.
- **2025-era clients** (detected with `isLegacyRequest`) go through a hand-built
  leg in `src/http.ts`: a per-request `WebStandardStreamableHTTPServerTransport`
  with `sessionIdGenerator: undefined` and `enableJsonResponse: true`. It exists
  because the SDK's built-in legacy fallback answers with an SSE stream *before*
  the tool handler runs, so a late `PoolBusyError` could no longer become HTTP 503.
  In JSON mode the response is produced only after the tool settles. A client
  disconnect is raced against the exchange (it never settles on its own in JSON
  mode) so the admission slot is always released.

Tool names, descriptions, input schemas, annotations and output text are
byte-identical to the stdio server (fixtures in `test/fixtures/mcp-baseline/`).

## Architecture

- **Boundary.** Binds `127.0.0.1` only, default port 8734 (`EPISODIC_MEMORY_HTTP_PORT`).
  `POST /mcp` only. Every request needs `Authorization: Bearer <token>`, read from
  `EPISODIC_MEMORY_HTTP_TOKEN_FILE` (regular file, owned by the current uid,
  mode exactly 0600, at least 32 bytes, no whitespace). Auth runs before the body
  is read. Body limit 1 MiB. The body is size-checked and parsed before admission:
  at most 16 concurrent requests containing a `tools/call` (a batch with any
  `tools/call` counts as one) and, separately, at most 64 other requests
  (initialize, notifications, `tools/list`, ping), so new sessions can still
  connect while searches run; beyond either cap the answer is 503 with
  `Retry-After: 1`. Concurrent body reads are bounded by the sum (80).
  No health or unauthenticated endpoint.
- **Worker pool.** Tool calls run on `EPISODIC_MEMORY_HTTP_WORKERS` worker threads
  (default 3, range 1-8; `dist/tool-worker.js`). Each worker owns its own
  embedding model (warmed up in the background, bounded at 60 s) and its own
  index connection. A busy pool queues (bounded) and then answers 503. Workers
  load the model offline-only (`allowRemoteModels = false`): a missing or broken
  cache fails fast instead of waiting on the network (stdio and CLI keep the
  library default).
- **Read-only index.** Workers open the SQLite index read-only and never migrate
  it. Indexing and sync stay with the normal sync/index CLIs and hooks; the
  service never writes the index or the archive.
- **`read` restriction.** The shared `read` tool only opens existing `.jsonl`
  files whose real path (symlinks resolved) is inside the conversation archive
  or a configured transcript source directory. Anything else is an error
  (`src/read-policy.ts`). The root check runs before any existence or type
  check, so every path outside the roots gets the same error whether or not it
  exists.
- **Deadlines.** Each tool call has a deadline timed from dispatch
  (`EPISODIC_MEMORY_TOOL_DEADLINE_MS`, default 100000). On expiry, client
  cancel or disconnect the worker is retired and replaced (live workers are
  capped at twice the pool size) and the caller gets a tool error. Workers are
  never terminated (that aborts the process mid ONNX load); a retired worker
  disposes its model and exits itself only after its in-flight call has settled
  and any model load has finished. It never disposes under a running call: if
  the call is still running after 30 s it logs that and stays retired (still
  counted toward the cap) until the call settles, or until the watchdog below
  restarts the service.
- **Watchdog.** If a retiring worker is still alive 2 × the deadline after it
  was retired, or calls are queued while no worker slot is usable at the cap
  for 2 × the deadline, the service logs `episodic-memory tool pool wedged (...)`
  and exits with code 1; launchd `KeepAlive` restarts it (after `ThrottleInterval`).
  In-flight requests on that process fail; clients retry.
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
- The service runs with the plist environment only (`HOME`, `PATH`, token file,
  port). Per-session `EPISODIC_MEMORY_CONFIG_DIR`, `XDG_CONFIG_HOME`,
  `EPISODIC_MEMORY_DB_PATH` and `PERSONAL_SUPERPOWERS_DIR` are **ignored**: a
  session that sets them gets the default index through the service, unlike its
  old stdio server. They must be unset for parity (the probe drops them so it
  checks the index the service reads).
- Headless `claude` runs with `--strict-mcp-config` do not see plugin MCP
  servers, so they have no episodic-memory tools (see below).

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
| `install` | Checks the pinned Node, creates the state dir (0700), token (created once, never overwritten), log and headers helper; runs `npm install --no-package-lock` (no lockfile exists) and `npm run build`; native check (better-sqlite3 + sqlite-vec); copies the embedding model cache from the registered plugin install if absent and validates it by an offline load; then `npm test` (embedding tests need the cache); writes the plist, `launchctl bootout` (ignored) and `bootstrap gui/<uid>`; then probes (waits up to 90 s). |
| `probe` | Runs `scripts/probe-live.mjs` (session-only index overrides removed from its env). First, read-only: the index's `MAX(embedding_version)` must equal this build's `EMBEDDING_VERSION` (`src/embedding-migration.ts`); a mismatch means the index needs `episodic-memory sync` with this build (the service never migrates). Then with a modern and a legacy client: `tools/list` must equal the baseline catalog (name, description, schema, annotations), a text `search`, a `read` of the first hit (lines 1-5), and a default-mode `search` (no `mode`, i.e. vector + text, so the embedding model must work). Prints only counts, versions, latencies and `ok`/`fail`. |
| `switch-clients [--claude-mode plugin-manifest\|user-scope]` | Requires a passing probe. Preflight reads and parses every target and checks each is the expected pre-switch form, or already switched, which means exactly equal to the recorded switched entry (and, for Codex, carrying the current token); anything else is drift and is refused naming the file. A re-run of a complete switch is a no-op. Writes the 0600 record and backups before editing; edits are atomic. On failure, each file already edited is restored only if it still holds the switched entry (a later edit is left alone); if every recorded file is readable and back to its original the record becomes `active: false` with `failed`; otherwise (a file still switched, edited by someone else, failed to restore, or unreadable/unparseable) it stays `active: true` with `failed` and an `unresolved` list of `{path, reason}`, and `rollback` finishes the job once those files are fixed. The Codex config is set to exactly 0600 whenever the bearer is written (a one-line notice is printed if its mode changed). |
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

**Persistence across plugin upgrades is not in place yet.** A plugin upgrade
installs a new version directory with the stdio manifests, and Claude sessions
started after it use stdio again until the switch is re-applied. The planned
plugin patcher (outside this repo, pending) will re-apply the switch to newly
installed plugin versions while the record says `active: true`. Until then,
re-run `switch-clients` after a plugin upgrade (the new version's files are added
to the record; already-switched files are left as they are).

Record format (`switch-record.json`, 0600) that the patcher must preserve and extend:

```json
{
  "active": true,
  "mode": "plugin-manifest",
  "created": "<ISO-8601 UTC, from the first switch>",
  "files": {
    "/abs/path/to/plugin/<version>/.mcp.json": {
      "before_entry": {"command": "...", "args": ["..."]},
      "after_entry": {"type": "http", "url": "http://127.0.0.1:8734/mcp", "headersHelper": "<state>/headers-helper.sh"},
      "backup_path": "<evidence>/backups/<hash>-.mcp.json",
      "kind": "json",
      "key": ["mcpServers", "episodic-memory"]
    }
  }
}
```

The patcher keeps the top-level `active`, `mode` and `created` unchanged and adds
one `files[<absolute path>]` entry per edited file (`kind: "json"`, `key:
["mcpServers","episodic-memory"]`, `before_entry` = the entry it replaced,
`after_entry` = the entry it wrote, `backup_path` = a 0600 copy of the original
file or `null`). After a failed switch the record may also carry `failed` and
`unresolved`; leave them for `rollback`.

## After a rebuild

The service runs `dist/` from this worktree and loads it only at start. After any
`npm run build` (or `install`), restart it so it serves the new build:

```
launchctl kickstart -k gui/$(id -u)/com.local.episodic-memory-v2
```

then `python3 scripts/manage-local-service.py probe`.

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
Restored JSON files are re-serialised (`json.dumps`, 2-space indent), so their
formatting can differ from the original even though the content is identical;
the byte-exact originals are the 0600 backups under the evidence directory
(`backup_path` in the record). A record left `active: true` by a failed switch
(see `switch-clients`) is completed by the same command.

## Tests

`python3 -m unittest scripts/test_manage_local_service.py` (temporary HOME via
`EM_TEST_HOME`; no launchctl, npm or real config is touched) and `npm test`.

`npx tsx scripts/audit-archive-paths.mjs` checks every stored archive path
against the `read` policy: it exits 1 only if a path is outside the readable
roots; missing files are reported separately and do not fail it.
