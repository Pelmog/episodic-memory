# Shared stateless HTTP for episodic-memory — design

Approved by Gordon on 2026-10-13. Precedent: `~/repos/outlook-mcp-v2` (`STATELESS-HTTP.md`), live since 2026-09-13.
Fleet context: `~/repos/mcp-fleet-v2/STATELESS-RESEARCH.md` names "episodic search/read" as a first custom v2 candidate.

## Problem

Every Claude and Codex session spawns its own episodic-memory MCP server (plus a Python launcher and a Node
wrapper). On 2026-10-13 there were 108 `mcp-server.js` instances, about 11 GB including compressed memory, each
loading its own copy of the embedding model on first search. The server's `search`/`read` tools hold no
per-session state: they query one shared SQLite index and read transcript files.

## Design

1. **Protocol.** Port the server from MCP TypeScript SDK v1 to SDK v2 (`@modelcontextprotocol/server` 2.3.1) and
   serve HTTP through `createMcpHandler` with `legacy: "stateless"`: MCP 2026-07-28 requests plus a stateless
   fallback for 2025-era clients, no protocol session IDs, a fresh protocol server per request. The stdio entry
   point stays (default when `--http` is absent).
2. **Tool surface unchanged.** `search` and `read` keep their names, hand-written JSON input schemas,
   annotations and output text. Use the v2 low-level `Server` (not `McpServer`) so schemas are not regenerated
   from zod.
3. **HTTP boundary** (copied from Outlook v2): bind `127.0.0.1` only; Host and Origin validation; bearer token
   from an owner-only (0600) file, compared in constant time, ≥32 bytes; only `POST /mcp`; request body ≤ 1 MiB;
   at most 16 concurrent requests (503 beyond); no unauthenticated endpoint; subscriptions disabled.
4. **`read` restriction (shared HTTP only).** The shared service resolves the requested path with `realpath` and
   refuses anything that is not a `.jsonl` file inside the conversation archive or a transcript source directory
   (`getArchiveDir()` + `getConversationSourceDirs()`). Stdio keeps today's behaviour.
5. **One warm process.** The service loads the embedding model once at startup; if that fails it logs and keeps
   serving (text search still works, matching existing degrade behaviour). Index and sync are unchanged; the
   service reads the same `~/.config/superpowers/conversation-index/db.sqlite`.

## Deployment

6. LaunchAgent `com.local.episodic-memory-v2`, port **8734**, run with the dedicated runtime
   `~/.local/share/episodic-memory/runtime/node-v24.21.0-darwin-arm64/bin/node` from this worktree's build. State,
   token and logs under `~/.local/share/mcp-fleet/episodic-memory/` (owner-only).
7. **Claude.** Preferred: rewrite the installed plugin's MCP entry to `type: http` so tool names
   (`mcp__plugin_episodic-memory_episodic-memory__search`/`__read`) and the `search-conversations` agent keep
   working; `~/.local/bin/episodic-memory-patch` re-applies it after plugin upgrades. This must be verified
   empirically first. Fallback: user-scope `episodic-memory` HTTP entry plus patched agent tool names.
8. **Codex.** `[mcp_servers.episodic-memory]` → `url` + `http_headers` bearer, keeping the existing timeouts.
9. **Rollout.** Install → probe (modern, legacy, real Claude and Codex clients, parity with stdio) → **stop for
   Gordon's approval** → switch both clients with backups → running sessions adopt on restart (nothing
   force-killed) → rollback restores only these entries and refuses to overwrite later edits.

## Out of scope

Upstream PR, LSP changes, indexing/summarizer changes, retiring the stdio code path.
