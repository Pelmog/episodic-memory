# Shared Stateless HTTP for episodic-memory — Implementation Plan (rev 2, Gate 1 adopted)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve episodic-memory's `search`/`read` MCP tools from one shared, stateless Streamable-HTTP process (MCP 2026-07-28, TypeScript SDK v2) on 127.0.0.1:8734, so Claude and Codex sessions stop spawning ~108 per-session stdio servers.

**Architecture:** Capture a byte-exact baseline of today's tool surface, extract it into an SDK-agnostic module, port the server to SDK v2's low-level `Server`, and run shared-mode tool calls in a small `worker_threads` pool (each worker: its own read-only DB connection and embedding pipeline) so synchronous SQLite work can neither stall other clients nor run past a deadline. An HTTP boundary copied from `~/repos/outlook-mcp-v2` fronts the pool. A Python manager installs a LaunchAgent and switches/rolls back client configs transactionally.

**Tech Stack:** TypeScript ESM (tsc + esbuild bundles `dist/mcp-server.js` and `dist/tool-worker.js`), `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/node` 2.1.1, `@modelcontextprotocol/client` 2.3.1 (dev), v1 `@modelcontextprotocol/sdk` (dev, legacy-client tests), vitest, Node `worker_threads`, Python 3, launchd.

**Spec:** `docs/superpowers/specs/2026-10-13-stateless-http-v2-design.md`

**Gate 1 review:** Codex `gpt-6.1-sol`/xhigh thread `01a1372e-1c37-7851-903f-a00170820874`. Adopted corrections are numbered **G1-1 … G1-20** inline.

## Global Constraints

- Worktree `~/repos/episodic-memory-v2`, branch `feat/stateless-http-v2` (base upstream `main` 7e06519). Never touch `~/repos/episodic-memory`.
- `CLAUDE.md` rules: edit `src/`, `npm run build`, commit `dist/` with `src/`; never edit `src/version.ts`; tests isolate via `TEST_DB_PATH`/`TEST_ARCHIVE_DIR`/`TEST_PROJECTS_DIR`/`EPISODIC_MEMORY_CONFIG_DIR` and must `delete process.env.EPISODIC_MEMORY_DB_PATH` first (it overrides `TEST_DB_PATH`, `src/paths.ts:219`) (G1-20).
- **Pinned toolchain for every install/build/test command (G1-15):** `export PATH="$HOME/.local/share/episodic-memory/runtime/node-v24.21.0-darwin-arm64/bin:$PATH"` before `npm`/`npx`/`node`. Native modules must be built for this runtime.
- SDK pins (exact): `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/node@2.1.1`, `@modelcontextprotocol/client@2.3.1`. Verified exports (2026-10-13, scratch install): server `Server`, `McpServer`, `createMcpHandler`, `CreateMcpHandlerOptions.legacy: 'stateless'|'reject'`; server/stdio `serveStdio`; node `localhostHostValidation`, `localhostOriginValidation`, `toNodeHandler`; client `Client`, `StreamableHTTPClientTransport`; **client stdio transport is `@modelcontextprotocol/client/stdio`** (`StdioClientTransport`). Handler cancellation: `ctx.mcpReq.signal`.
- Tool names, JSON input schemas, annotations, descriptions and output text unchanged **byte-for-byte** against the Task 1 baseline fixtures.
- HTTP: `127.0.0.1` only; port 8734 (`EPISODIC_MEMORY_HTTP_PORT`, 1024–65535; `0` only under vitest); bearer from `EPISODIC_MEMORY_HTTP_TOKEN_FILE` which must be a regular file owned by the current uid with mode exactly 0600, token ≥ 32 bytes, no whitespace (G1-16); `POST /mcp` only; body ≤ 1 MiB; ≤ 16 admitted requests (503 beyond); `legacy: 'stateless'`, `maxSubscriptions: 0`.
- Shared execution: `EPISODIC_MEMORY_HTTP_WORKERS` (default 3, 1–8); per-call deadline `EPISODIC_MEMORY_TOOL_DEADLINE_MS` (default 100000 — below Codex `tool_timeout_sec` 120); per-worker embedding warm-up bound 60 s.
- Shared mode opens the index **read-only** and never migrates it (G1-16).
- Service: label `com.local.episodic-memory-v2`; `~/.local/share/mcp-fleet/episodic-memory/` (dir 0700; token, record, log files 0600; `headers-helper.sh` 0700).
- Secrets never appear in argv, logs, probe output or evidence (G1-13).
- Live client configs change ONLY via `switch-clients`, ONLY after Gordon approves. No running session is killed.

## Review Focus

1. **A slow search must not stall other clients** (text search measured at 4.8 s on the live 4.1 GB index). Expect: other requests complete on other workers; a call past its deadline returns an error and its worker is replaced. Tests: Task 5 blocking-worker tests; Task 6 SDK-client admission test.
2. **`read` path escapes** (`..`, symlinks out, sibling-prefix dirs, relative, non-`.jsonl`) and **search→read compatibility** (every `archive_path` search returns must be readable). Tests: Task 3 policy + roundtrip; Task 10 live audit.
3. **Embedding model unavailable** (offline, cache missing, stalled load). Expect: service binds and answers; authenticated text search succeeds; vector search returns the existing error text; warm-up is bounded. Tests: Task 7.
4. **Legacy (2025-era) clients** — what Claude Code and Codex speak today. Expect: both tools work via legacy and modern clients over HTTP and stdio, against the built bundle. Tests: Tasks 4, 6; Task 10 real clients.
5. **Config drift / partial failure around switch and rollback**, including plugin upgrades in between. Expect: transactional switch, idempotent re-run, rollback restores only the episodic entries, refuses on episodic-entry drift, and deactivates upgrade persistence. Tests: Task 8 executable tests with a temp HOME.
6. **Service down when a Claude session starts** (Claude retries 5×, 1→16 s, then marks failed until `/mcp` reconnect). Expect: launchd `KeepAlive` restarts within 10 s; doc gives the `/mcp` remedy. Test: Task 10 Step 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `test/fixtures/mcp-baseline/` (create) | Byte-exact v1 catalog and tool outputs (Task 1) |
| `scripts/capture-mcp-baseline.mjs` (create) | Regenerates the baseline from a given server command |
| `src/mcp-tools.ts` (create) | SDK-agnostic `TOOL_DEFINITIONS`, `callTool(name, args, options)` |
| `src/db.ts` (modify) | add `openReadOnlyDatabase()`; `src/search.ts` uses a configurable opener |
| `src/search.ts` (modify) | `try/finally` close; `configureSearchDatabase()` |
| `src/embeddings.ts` (modify) | singleflight `initEmbeddings` |
| `src/read-policy.ts` (create) | `getReadableRoots()`, `resolveReadablePath()` |
| `src/mcp-factory.ts` (create) | `createEpisodicServer({ execute })` → SDK v2 `Server` |
| `src/tool-pool.ts`, `src/tool-worker.ts` (create) | worker pool + worker entry (bundled to `dist/tool-worker.js`) |
| `src/http.ts` (create) | `createEpisodicHttpServer`, `readHttpConfig`, `startHttp` |
| `src/mcp-server.ts` (modify) | entry: stdio default; `--http` → `startHttp()` |
| `tsconfig.test.json` (create) | type-check gate for tests (G1-8) |
| `scripts/manage-local-service.py`, `scripts/test_manage_local_service.py`, `scripts/probe-live.mjs`, `scripts/claude-plugin-http-probe.sh`, `scripts/audit-archive-paths.mjs` (create) | ops |
| `STATELESS-HTTP.md` (create) | operator doc |

---

### Task 1: Baseline capture, then extract the SDK-agnostic tool surface

**Files:** Create `scripts/capture-mcp-baseline.mjs`, `test/fixtures/mcp-baseline/{catalog.json,search-text-json.txt,search-text-markdown.txt,read.txt}`, `test/fixtures/mcp-baseline/conversation.jsonl`, `src/mcp-tools.ts`, `test/mcp-tools.test.ts`, `test/mcp-baseline.test.ts`; Modify `src/mcp-server.ts`.

**Interfaces — Produces:**
- `export type ToolDefinition = { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }; annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }`
- `export const TOOL_DEFINITIONS: ToolDefinition[]` (moved verbatim)
- `export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }`
- `export type ToolCallOptions = { resolveReadPath?: (requested: string) => string; signal?: AbortSignal }` (G1-9)
- `export async function callTool(name: string, args: unknown, options?: ToolCallOptions): Promise<ToolResult>` — throws nothing; checks `options.signal?.throwIfAborted()` before work and between the search and format phases.

- [ ] **Step 1: Baseline (before any source change).** `npm ci && npm run build`. Write `scripts/capture-mcp-baseline.mjs` (v1 SDK client over stdio) that: builds an isolated env (temp dirs; `delete EPISODIC_MEMORY_DB_PATH`), indexes `test/fixtures/mcp-baseline/conversation.jsonl` (a 3-exchange Claude transcript copied from `test/fixtures` style) by running `node dist/index-cli.js` equivalents the existing tests use (copy the approach from `test/integration.test.ts`), then calls `tools/list` and writes `JSON.stringify(result, null, 2)` to `catalog.json`; calls `search` `{query:'<a phrase from the fixture>', mode:'text', response_format:'json'}` and `'markdown'`, and `read` on the archived path with `startLine:1,endLine:3`, writing each `content[0].text` verbatim. Commit fixtures with the script.
- [ ] **Step 2: Failing tests.** `test/mcp-baseline.test.ts` re-runs the same calls against `dist/mcp-server.js` and asserts byte equality with the fixture files (paths in outputs are normalised by replacing the temp root with `<ROOT>` in both capture and test). `test/mcp-tools.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
beforeAll(() => {
  delete process.env.EPISODIC_MEMORY_DB_PATH;
  root = mkdtempSync(join(tmpdir(), 'em-tools-'));
  for (const d of ['archive', 'projects', 'config']) mkdirSync(join(root, d), { recursive: true });
  Object.assign(process.env, { TEST_DB_PATH: join(root, 'db.sqlite'), TEST_ARCHIVE_DIR: join(root, 'archive'), TEST_PROJECTS_DIR: join(root, 'projects'), EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config') });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('mcp-tools', () => {
  it('matches the baseline catalog byte-for-byte', async () => {
    const { TOOL_DEFINITIONS } = await import('../src/mcp-tools.js');
    const baseline = JSON.parse(readFileSync('test/fixtures/mcp-baseline/catalog.json', 'utf8'));
    expect(JSON.stringify({ tools: TOOL_DEFINITIONS }, null, 2)).toBe(JSON.stringify(baseline, null, 2));
  });
  it('returns errors in-band', async () => {
    const { callTool } = await import('../src/mcp-tools.js');
    expect(await callTool('nope', {})).toEqual({ isError: true, content: [{ type: 'text', text: 'Error: Unknown tool: nope' }] });
    expect((await callTool('search', { query: 'x' })).isError).toBe(true);
  });
  it('read uses resolveReadPath and reports its refusal', async () => {
    const { callTool } = await import('../src/mcp-tools.js');
    const file = join(root, 'archive', 'c.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-10-13T00:00:00Z' }) + '\n');
    const seen: string[] = [];
    expect((await callTool('read', { path: '/x.jsonl' }, { resolveReadPath: (p) => { seen.push(p); return file; } })).isError).toBeFalsy();
    expect(seen).toEqual(['/x.jsonl']);
    expect(await callTool('read', { path: file }, { resolveReadPath: () => { throw new Error('Path is outside the conversation archive and transcript directories'); } }))
      .toEqual({ isError: true, content: [{ type: 'text', text: 'Error: Path is outside the conversation archive and transcript directories' }] });
  });
  it('honours an aborted signal', async () => {
    const { callTool } = await import('../src/mcp-tools.js');
    const c = new AbortController(); c.abort(new Error('cancelled'));
    expect((await callTool('search', { query: 'hello' }, { signal: c.signal })).isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run** — `npx vitest run test/mcp-tools.test.ts` → FAIL (module missing); `npx vitest run test/mcp-baseline.test.ts` → PASS (baseline vs unchanged server).
- [ ] **Step 4: Implement.** Move the zod schemas, `handleError`, the two definitions (`TOOL_DEFINITIONS`) and the call body (`callTool`) from `src/mcp-server.ts` to `src/mcp-tools.ts` verbatim, except: `read` resolves via `options.resolveReadPath` when given (else today's `fs.existsSync` check), and `options.signal?.throwIfAborted()` is called at entry and after the search step. `src/mcp-server.ts` (still v1) uses `{ tools: TOOL_DEFINITIONS }` and `callTool(request.params.name, request.params.arguments)`.
- [ ] **Step 5: Verify** — `npm run build && npm test` → PASS (baseline byte equality holds).
- [ ] **Step 6: Commit** — `git add -A scripts/capture-mcp-baseline.mjs test src dist && git commit -m "refactor: extract MCP tool surface behind byte-exact baseline fixtures"`

---

### Task 2: Search DB cleanup, singleflight embeddings, read-only opener

**Files:** Modify `src/search.ts`, `src/embeddings.ts`, `src/db.ts`; Create `test/search-db-lifecycle.test.ts`, `test/embeddings-singleflight.test.ts`, `test/db-readonly.test.ts`.

**Interfaces — Produces:**
- `src/db.ts`: `export function openReadOnlyDatabase(): Database.Database` — `new Database(getDbPath(), { readonly: true, fileMustExist: true })`, `sqliteVec.load(db)`, `busy_timeout = 5000`, then verifies `exchanges` has every column `migrateSchema` would add, `tool_calls` exists and `vec_exchanges` exists; otherwise closes and throws `Error('The conversation index schema is older than this build; run "episodic-memory sync" first.')`.
- `src/search.ts`: `export function configureSearchDatabase(opener: () => Database.Database): void` (default `initDatabase`); every search path closes the handle in `finally` (G1-1).
- `src/embeddings.ts`: concurrent `initEmbeddings()` calls share one in-flight promise; a rejected load clears it so a later call retries (G1-12).

- [ ] **Step 1: Failing tests.**
  - `test/search-db-lifecycle.test.ts`: `vi.mock('../src/embeddings.js', () => ({ initEmbeddings: vi.fn(async () => { throw new Error('boom'); }), generateQueryEmbedding: vi.fn() }))`; call `configureSearchDatabase(() => fakeDb)` where `fakeDb` is a real `initDatabase()` handle wrapped so `close` is a spy; run `searchConversations('hello', { mode: 'vector' })` expecting rejection and `close` called once; also a text search whose `prepare` throws → `close` called.
  - `test/embeddings-singleflight.test.ts`: `vi.mock('@huggingface/transformers', ...)` (pattern from `test/embeddings-unavailable.test.ts`) with a `pipeline` spy that resolves after 50 ms; `await Promise.all([initEmbeddings(), initEmbeddings(), initEmbeddings()])` → spy called once; a first-call rejection followed by a second call → spy called twice.
  - `test/db-readonly.test.ts`: `initDatabase()` in a temp `TEST_DB_PATH`, close; `openReadOnlyDatabase()` succeeds and `db.prepare('DELETE FROM exchanges').run()` throws `SQLITE_READONLY`; a DB file created with only `CREATE TABLE exchanges(id TEXT)` → throws the schema message; missing file → throws.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `search.ts` wrap the body after `const db = opener()` in `try { … } finally { db.close(); }` (remove the trailing `db.close()`), for every function that opens the DB. In `embeddings.ts`:

```ts
let initPromise: Promise<void> | null = null;
export async function initEmbeddings(): Promise<void> {
  if (embeddingPipeline) return;
  initPromise ??= loadPipeline().finally(() => { if (!embeddingPipeline) initPromise = null; });
  return initPromise;
}
```

where `loadPipeline()` is today's body of `initEmbeddings` unchanged.
- [ ] **Step 4: Verify** — `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "fix: close search DB on failure, singleflight embedding load, read-only index opener"` (add new test files).

---

### Task 3: `read` path policy and search→read compatibility

**Files:** Create `src/read-policy.ts`, `test/read-policy.test.ts`, `scripts/audit-archive-paths.mjs`.

**Interfaces:** Consumes `getArchiveDir()`, `getConversationSourceDirs()` (`src/paths.ts:100`, honours `TEST_PROJECTS_DIR`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CURSOR_HOME`, `OMP_HOME`, `XDG_DATA_HOME`). Produces `getReadableRoots(): string[]`, `resolveReadablePath(requested: string, roots?: string[]): string` (errors: `Path must be absolute`, `File not found: <p>`, `Only .jsonl conversation files can be read`, `Path is outside the conversation archive and transcript directories`).

- [ ] **Step 1: Failing tests** — the five policy cases (inside root; relative; missing; non-jsonl; `..` / sibling-prefix `archive-evil` / symlink-out), plus (G1-17):
  - root discovery: with `TEST_ARCHIVE_DIR`, `TEST_PROJECTS_DIR`, `CODEX_HOME` pointing at temp dirs, `getReadableRoots()` contains each realpath and omits non-existent dirs;
  - roundtrip: index the Task 1 fixture conversation into a temp DB, run `callTool('search', {query, mode:'text', response_format:'json'})`, then for every returned `exchange.archivePath` call `callTool('read', {path}, { resolveReadPath: (p) => resolveReadablePath(p) })` → not `isError`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/read-policy.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { getArchiveDir, getConversationSourceDirs } from './paths.js';

export function getReadableRoots(): string[] {
  const roots = new Set<string>();
  for (const dir of [getArchiveDir(), ...getConversationSourceDirs()]) {
    try { roots.add(fs.realpathSync(dir)); } catch { /* absent on this machine */ }
  }
  return [...roots];
}

export function resolveReadablePath(requested: string, roots: string[] = getReadableRoots()): string {
  if (!path.isAbsolute(requested)) throw new Error('Path must be absolute');
  let real: string;
  try { real = fs.realpathSync(requested); } catch { throw new Error(`File not found: ${requested}`); }
  if (!fs.statSync(real).isFile() || path.extname(real) !== '.jsonl') throw new Error('Only .jsonl conversation files can be read');
  if (!roots.some((root) => real.startsWith(root + path.sep))) throw new Error('Path is outside the conversation archive and transcript directories');
  return real;
}
```

`scripts/audit-archive-paths.mjs`: opens the index read-only (`openReadOnlyDatabase` from `dist`? — no: plain `better-sqlite3` `{readonly:true}`), `SELECT DISTINCT archive_path FROM exchanges`, and reports the count not under `getReadableRoots()` (import from the built `dist/` CLI bundle is not available, so re-implement the root list by importing `src` via `tsx`: run as `npx tsx scripts/audit-archive-paths.mjs`). Prints counts and up to 10 sample offending prefixes; exit 1 if any.
- [ ] **Step 4: Verify** — `npx vitest run test/read-policy.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: confine shared read to archive and transcript dirs; audit stored paths"`.

---

### Task 4: Port to SDK v2 with byte-exact stdio

**Files:** Modify `package.json`, `package-lock.json`, `src/mcp-server.ts`, `test/mcp-server.test.ts`; Create `src/mcp-factory.ts`, `tsconfig.test.json`.

**Interfaces:** Produces `export type ToolExecutor = (name: string, args: unknown, signal: AbortSignal) => Promise<ToolResult>` and `export function createEpisodicServer(options?: { execute?: ToolExecutor }): Server`. Default executor: `(name, args, signal) => callTool(name, args, { signal })`.

- [ ] **Step 1: Deps (pinned toolchain).** `npm install --save-exact @modelcontextprotocol/server@2.3.1 @modelcontextprotocol/node@2.1.1`; `npm install --save-exact --save-dev @modelcontextprotocol/client@2.3.1`; move `@modelcontextprotocol/sdk` to `devDependencies`. Add to `package.json` scripts: `"typecheck:test": "tsc -p tsconfig.test.json --noEmit"` and make `"test": "npm run typecheck:test && vitest run"`. `tsconfig.test.json` extends `tsconfig.json`, `include: ["src", "test"]`, `noEmit: true`.
- [ ] **Step 2: Failing tests** — in `test/mcp-server.test.ts` add a modern stdio case:

```ts
import { Client as ModernClient } from '@modelcontextprotocol/client';
import { StdioClientTransport as ModernStdio } from '@modelcontextprotocol/client/stdio';
```

asserting `listTools()` equals `catalog.json` and `search`/`read` outputs equal the baseline fixtures; keep the existing v1 cases. Also assert the factory type-checks against SDK types without casts: in `src/mcp-factory.ts` include `const _assignable: Tool[] = TOOL_DEFINITIONS;` (`import type { Tool } from '@modelcontextprotocol/server'`) (G1-8).
- [ ] **Step 3: Implement** `src/mcp-factory.ts`:

```ts
import { Server, type Tool } from '@modelcontextprotocol/server';
import { TOOL_DEFINITIONS, callTool, type ToolResult } from './mcp-tools.js';
import { VERSION } from './version.js';

export type ToolExecutor = (name: string, args: unknown, signal: AbortSignal) => Promise<ToolResult>;
const inProcess: ToolExecutor = (name, args, signal) => callTool(name, args, { signal });
const _assignable: Tool[] = TOOL_DEFINITIONS;

export function createEpisodicServer({ execute = inProcess }: { execute?: ToolExecutor } = {}): Server {
  const server = new Server({ name: 'episodic-memory', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler('tools/call', async (request, ctx) =>
    execute(request.params.name, request.params.arguments, ctx.mcpReq.signal));
  return server;
}
```

`src/mcp-server.ts` entry: `serveStdio(() => createEpisodicServer())`; `--http` → `(await import('./http.js')).startHttp()`; a temporary `src/http.ts` stub `export async function startHttp(): Promise<void> { throw new Error('HTTP mode not built yet'); }` until Task 6. Extend the `bundle` script to also bundle `src/tool-worker.ts` → `dist/tool-worker.js` once it exists (Task 5).
- [ ] **Step 4: Verify** — `npm run build && npm test` → PASS (v1 + v2 stdio, baseline byte equality, test type-check).
- [ ] **Step 5: Commit** — `git commit -m "feat: serve MCP through TypeScript SDK v2 with byte-exact stdio"`.

---

### Task 5: Worker pool for shared execution

**Files:** Create `src/tool-pool.ts`, `src/tool-worker.ts`, `test/tool-pool.test.ts`, `test/fixtures/workers/blocking-worker.mjs`; Modify `package.json` bundle script.

**Interfaces:**
- `src/tool-worker.ts` (entry, bundled to `dist/tool-worker.js`): on start calls `configureSearchDatabase(openReadOnlyDatabase)`; starts warm-up `Promise.race([initEmbeddings(), timeout(60_000)])` without blocking message handling (failure logged once to stderr; later vector calls retry through singleflight); handles `{ id, name, args }` messages by `callTool(name, args, { resolveReadPath: resolveReadablePath })` and posts `{ id, result }`.
- `src/tool-pool.ts`:
  - `export class PoolBusyError extends Error {}`
  - `export type PoolOptions = { workerPath: string; size: number; deadlineMs: number; maxQueue: number }`
  - `export function createToolPool(options: PoolOptions): { run: ToolExecutor; close(): Promise<void>; stats(): { busy: number; queued: number; size: number } }`
  - Semantics: idle worker → dispatch; else queue (≤ `maxQueue`, else reject `PoolBusyError`); `signal` aborted while queued → removed, resolves `{isError:true, content:[{type:'text', text:'Error: Request cancelled'}]}`; aborted while running or deadline elapsed → `worker.terminate()`, spawn replacement, resolve `Error: Request cancelled` / `Error: Tool call exceeded the ${deadlineMs} ms deadline`; worker `error`/`exit` mid-call → resolve `Error: Tool worker crashed` and respawn (G1-4, G1-7, G1-9).

- [ ] **Step 1: Failing tests** — `test/fixtures/workers/blocking-worker.mjs` (plain ESM, `parentPort.on('message', ({id,name,args}) => { if (name==='block') { const end=Date.now()+args.ms; while (Date.now()<end); } parentPort.postMessage({ id, result: { content:[{type:'text', text:`${name}:${process.pid}:${require('node:worker_threads').threadId}`}] } }); })` — use `import { parentPort, threadId } from 'node:worker_threads'`). Tests with `size: 2`:
  - a `block` 1500 ms call in flight; a `fast` call started 50 ms later resolves in < 500 ms (Review Focus 1);
  - `deadlineMs: 300` with `block` 2000 ms → deadline error in < 1000 ms; next call succeeds (replacement worker);
  - abort while running → `Request cancelled`, replacement works; abort while queued (size 1, two blocks) → second resolves cancelled without running;
  - `maxQueue: 1`, size 1: third concurrent call rejects `PoolBusyError`;
  - `close()` terminates all workers (no open handles: vitest exits).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/tool-pool.ts` (≈120 lines): array of `{ worker, busy: {id, resolve, timer, onAbort} | null }`; FIFO queue; `dispatch()` on completion; `replace(slot)`; deadline via `setTimeout` on the main thread (main thread is never blocked by tool work). `src/tool-worker.ts` as specified. Bundle: append `&& esbuild src/tool-worker.ts --bundle --platform=node --format=esm --outfile=dist/tool-worker.js <same --external flags>` to the `bundle` script.
- [ ] **Step 4: Verify** — `npm run build && npm test` → PASS; `node -e "new (require('node:worker_threads').Worker)('./dist/tool-worker.js')"` starts and exits on terminate.
- [ ] **Step 5: Commit** — `git commit -m "feat: worker pool with deadlines and cancellation for shared tool calls"`.

---

### Task 6: HTTP boundary over the pool

**Files:** Replace `src/http.ts`; Create `test/http.test.ts`, `test/http-bundle.test.ts`.

**Interfaces:** Consumes `createEpisodicServer({ execute })`, `createToolPool`. Produces `export function createEpisodicHttpServer(token: string, execute: ToolExecutor): { http: import('node:http').Server; close(): Promise<void> }`, `export const MAX_BODY_BYTES = 1048576`, `export const MAX_ADMITTED = 16`.

- [ ] **Step 1: Failing tests** — `test/http.test.ts` (in-process, fake executors), with **separate typed helpers** `modernClient(url)` and `legacyClient(url)` (no `as never`) (G1-8):
  - two modern + one legacy client: catalogs equal each other and `catalog.json` byte-for-byte; both tools via both client kinds (G1-18);
  - auth/Host/Origin/404/405/400/413 cases (as Outlook's test);
  - **admission:** executor = `(…) => gate` (a promise released in `finally`); start 16 `modernClient.callTool` calls; wait until the executor has been entered 16 times (counter + polling ≤ 2 s); a 17th request via the SDK client is rejected (client error carrying HTTP 503); release the gate; all 16 resolve successfully; a further call succeeds (G1-6);
  - token constructor validation.
  `test/http-bundle.test.ts` (G1-18): spawn `node dist/mcp-server.js --http` with a 0600 temp token file, `EPISODIC_MEMORY_HTTP_PORT` = a free port found via `net.createServer().listen(0)`, isolated `TEST_*` dirs containing an indexed fixture DB; wait for `HTTP ready`; run both tools through modern and legacy clients; compare outputs with baseline fixtures; SIGTERM → exit 0.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — Outlook's `createOutlookHttpServer` structure (see `~/repos/outlook-mcp-v2/src/http.ts`) with: factory `() => createEpisodicServer({ execute })`; `createMcpHandler(factory, { legacy: 'stateless', maxSubscriptions: 0, onerror })`; `localhostHostValidation()`, `localhostOriginValidation()`, `toNodeHandler()`; constant-time bearer check; `/mcp` only; `POST` only; `MAX_ADMITTED`; 1 MiB streamed body cap; JSON parse → 400; `http.requestTimeout = 30_000` (request receipt only — tool execution is bounded by the pool deadline, G1-7); `http.headersTimeout = 10_000`; `close()` closes the handler then the server.
- [ ] **Step 4: Verify** — `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: authenticated stateless HTTP boundary over the tool pool"`.

---

### Task 7: `startHttp()` — config, bounded warm-up, lifecycle

**Files:** Modify `src/http.ts`, `src/mcp-server.ts`; Create `test/http-startup.test.ts`.

**Interfaces:** `export async function readHttpConfig(env: NodeJS.ProcessEnv): Promise<{ port: number; token: string; workers: number; deadlineMs: number }>`; `export async function startHttp(options?: { workerPath?: string }): Promise<{ port: number; close(): Promise<void> }>`.

- [ ] **Step 1: Failing tests:**
  - token file: missing env; not a regular file (directory); mode 0640 and 0400 rejected (exactly 0600 required); (owner check via `stat.uid === process.getuid()` — tested by mocking `fs.stat` to return another uid) (G1-16);
  - port: default 8734; `80`, `70000`, `abc` rejected; `0` accepted only with `VITEST`;
  - workers 1–8, deadline ≥ 1000 ms validation;
  - **embeddings unavailable** (G1-3, G1-17): `vi.mock('@huggingface/transformers')` throwing as in `test/embeddings-unavailable.test.ts` is not inherited by workers, so instead start the service with `workerPath` pointing at the real `dist/tool-worker.js` and env `EPISODIC_MEMORY_FORCE_EMBEDDINGS_UNAVAILABLE=1` — add that env check at the top of `loadPipeline()` (throws `EmbeddingsUnavailableError('Embeddings disabled by EPISODIC_MEMORY_FORCE_EMBEDDINGS_UNAVAILABLE')`, documented as test-only). Assert: service is listening immediately; an **authenticated** text search returns results; a vector search returns `isError` with the unavailable message.
  - **bounded warm-up:** with `EPISODIC_MEMORY_TEST_WARM_DELAY_MS=120000` (test-only hook in the worker's warm-up) the service still answers text search within 2 s (warm-up runs in the background and never gates binding).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `readHttpConfig`: `fs.lstat` → `isFile()`, `uid === process.getuid()`, `(mode & 0o777) === 0o600`; token rules; port/workers/deadline parsing. `startHttp`: config → `createToolPool({ workerPath: options.workerPath ?? fileURLToPath(new URL('./tool-worker.js', import.meta.url)), size: workers, deadlineMs, maxQueue: 64 })` → `createEpisodicHttpServer(token, pool.run)` → listen on `127.0.0.1` → log `episodic-memory HTTP ready on 127.0.0.1:<port> (<workers> workers)`; SIGINT/SIGTERM (skipped under vitest) → close server, then pool, exit 0 (5 s hard limit). `src/mcp-server.ts` `--http` → `await startHttp()`.
- [ ] **Step 4: Verify** — `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: start shared HTTP with validated config and background warm-up"`.

---

### Task 8: Service manager — install, probe, transactional switch, rollback

**Files:** Create `scripts/manage-local-service.py`, `scripts/test_manage_local_service.py`, `scripts/probe-live.mjs`, `STATELESS-HTTP.md`.

**Constants:** as rev 1 (`LABEL`, `PORT`, `URL`, `STATE`, `TOKEN`, `LOG`, `RECORD`, `HEADERS_HELPER`, `PLIST`, `NODE`, `CODEX_CONFIG`, `CLAUDE_JSON`, `EVIDENCE`) plus `INSTALLED_PLUGINS = HOME/".claude/plugins/installed_plugins.json"`. All paths derive from `HOME = Path(os.environ.get("EM_TEST_HOME") or Path.home())` so tests run against a temp HOME.

**Interfaces (importable):** `extract_block(text) -> str`; `codex_switch(text, url, token) -> str`; `codex_restore(current, switched_block, original_block) -> str` (raises `DriftError` if the current episodic block ≠ `switched_block`; otherwise replaces only that block); `claude_entry(url, helper) -> dict` = `{"type":"http","url":url,"headersHelper":helper}`; `registered_plugin_dir() -> Path` (from `INSTALLED_PLUGINS`, `episodic-memory@superpowers-marketplace`, scope `user`, exactly one entry — G1-10); `Switcher` class with `preflight()`, `apply()`, `rollback()`.

**Behaviour:**
- `install`: refuse if `NODE` missing; `STATE` 0700; token via `os.open(TOKEN, O_WRONLY|O_CREAT|O_EXCL, 0o600)` (never overwrite); `LOG` pre-created 0600; `HEADERS_HELPER` 0700 (`printf '{"Authorization":"Bearer %s"}' "$(cat "$TOKEN")"`); `npm ci && npm run build && npm test` with the pinned PATH; **native probe** (the better-sqlite3 + sqlite-vec script from `~/.local/bin/episodic-memory-patch:430-445`, run with `NODE` from `REPO`); **model cache**: copy `<registered plugin dir>/node_modules/@huggingface/transformers/.cache/Xenova/bge-small-en-v1.5` into the repo's equivalent if absent, then validate by an **offline load** (`node -e` importing `@huggingface/transformers`, `env.allowRemoteModels=false`, `pipeline('feature-extraction','Xenova/bge-small-en-v1.5',{dtype:<MODEL_DTYPE from src/embeddings.ts>})` and embedding one string) (G1-15); write `PLIST` (`ProgramArguments [NODE, REPO/dist/mcp-server.js, --http]`, env `EPISODIC_MEMORY_HTTP_TOKEN_FILE`, `EPISODIC_MEMORY_HTTP_PORT`, `HOME`, `PATH`=runtime bin first; `RunAtLoad`, `KeepAlive`, `ThrottleInterval` 5, logs → `LOG`, `WorkingDirectory` `REPO`); `launchctl bootout` (ignore) + `bootstrap gui/<uid>`; then `probe`.
- `probe`: `NODE scripts/probe-live.mjs` with `EPISODIC_MEMORY_HTTP_TOKEN_FILE`; modern and legacy clients; `tools/list` must equal the baseline catalog; `search` (json) then `read` of the first returned path (`startLine:1,endLine:5`); prints only counts, latencies and `ok`/`fail` — never tokens or transcript text (G1-13).
- `switch-clients [--claude-mode plugin-manifest|user-scope]` (G1-11): requires passing `probe`; **preflight** reads every target file, verifies parseability and that each current episodic entry is the expected pre-switch form (or already switched → idempotent no-op); writes `RECORD` (0600, atomic) **before** any edit: `{active: true, mode, created, files: {path: {before_entry, after_entry, backup_path}}}` with backups copied to `EVIDENCE` (0600) only if no backup for that path exists yet (originals are never replaced on re-run); each edit = read → compare current entry to `before_entry` → write temp file in the same dir → `os.replace` (atomic); on any failure, already-edited files are restored from the record and the record is marked `active: false, failed: <reason>`. Targets: Codex `[mcp_servers.episodic-memory]`; plugin-manifest mode → `.mcp.json` **and** `.claude-plugin/plugin.json` of `registered_plugin_dir()`; user-scope mode → `~/.claude.json` `mcpServers["episodic-memory"]` plus removal of the plugin manifest entries and agent tool-name edits (Task 9).
- `rollback`: for each recorded file: if the current episodic entry equals `after_entry` → restore `before_entry` atomically (unrelated content preserved); if it equals `before_entry` → skip; else raise `DriftError` naming the file and leave it untouched. Also restores entries recorded for later plugin versions by the patcher (`files` keys added by Task 9). On success sets `active: false` so the patcher stops re-applying (G1-10). Leaves the service running; prints the `launchctl bootout` command.

- [ ] **Step 1: Failing tests** — `scripts/test_manage_local_service.py` with `EM_TEST_HOME` temp HOME containing a fake `~/.codex/config.toml` (the rev-1 `CODEX` fixture), fake `installed_plugins.json` + plugin dir with both manifests (stdio entries), fake `~/.claude.json`:
  - Codex switch touches only the episodic block (rev-1 assertion) and keeps timeouts;
  - manifest switch writes `claude_entry` into both manifests and **no token** anywhere in them;
  - `switch-clients` twice → second run is a no-op, backups unchanged (idempotence);
  - injected failure on the second file write (monkeypatch `os.replace` to raise once) → first file restored, record `active: false` with `failed`;
  - rollback with an unrelated Codex edit (mongodb port change) → episodic restored, unrelated edit kept;
  - rollback after the user edited the episodic entry (Codex `tool_timeout_sec` or manifest `url`) → `DriftError`, file untouched;
  - rollback after a simulated plugin upgrade recorded by the patcher (extra `files` key) → that version restored too; record `active: false`.
  (`probe`/`install` side effects are not unit-tested; they run live in Task 10.)
- [ ] **Step 2: Run** `python3 -m unittest scripts/test_manage_local_service.py` → FAIL.
- [ ] **Step 3: Implement** script, `probe-live.mjs`, and `STATELESS-HTTP.md` (Outlook structure + worker pool, read-only index, `read` restriction, deadlines, `/mcp` reconnect remedy, commands, rollback).
- [ ] **Step 4: Verify** → unittest PASS; `npm test` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: install, probe, transactional switch and rollback for the shared service"`.

---

### Task 9: Claude mechanism verification and patcher integration

**Files:** Create `scripts/claude-plugin-http-probe.sh`; Modify `~/.local/bin/episodic-memory-patch` (backup to `EVIDENCE` first; outside repo); update `STATELESS-HTTP.md`.

- [ ] **Step 1: Probe (no live config touched).** Script starts a temporary service on a free port with a scratch 0600 token and an isolated temp index (fixture DB), creates a temp plugin `em-http-probe` whose `.claude-plugin/plugin.json` has `mcpServers.episodic-memory = {"type":"http","url":…,"headersHelper":"<tmp>/helper.sh"}`, then runs `claude -p --plugin-dir <tmp>/em-http-probe --strict-mcp-config --output-format json --allowedTools mcp__plugin_em-http-probe_episodic-memory__search "<prompt to call search with query from fixture, response_format json, print count>"`. Pass: exit 0; JSON shows the tool call; service saw an authenticated request. Negative control: helper prints a wrong token → tool unavailable/erroring. Token is read by the helper from a file; never in argv.
- [ ] **Step 2: Decide** `plugin-manifest` (pass) or `user-scope` (fail). For `user-scope`, Task 8's switch also: removes `mcpServers.episodic-memory` from both plugin manifests (recorded), patches `agents/search-conversations.md` `tools:` from `mcp__plugin_episodic-memory_episodic-memory__` to `mcp__episodic-memory__` (recorded), and the patcher persists both on upgrade (G1-2).
- [ ] **Step 3: Patcher (G1-5).** In the pinned-runtime block (`episodic-memory-patch:417-436`): when `RECORD` exists with `active: true`, the desired entry is the recorded `after_entry` for that manifest (HTTP), not the launcher; an entry equal to it is `ok transport-http`; a stdio launcher entry on a version not yet in the record is (apply mode) switched and **added to `RECORD.files`** with its own before/after, or (`--check`) reported `WOULD transport-http`; anything else is `FAIL`. When the record is absent or inactive, behaviour is exactly today's. `--check` never writes. Test against a temp copy of the plugin root via `EPISODIC_MEMORY_PLUGIN_ROOT` and `EM_TEST_HOME`: inactive → unchanged behaviour; active + pristine new version → `WOULD` under `--check`, `FIXED` in apply mode and recorded; re-run → `ok`; rollback (Task 8) restores the new version too.
- [ ] **Step 4: Commit** repo files: `git commit -m "feat: verify Claude plugin HTTP transport; persist it across plugin upgrades"`; record the patcher diff and backup path in `STATELESS-HTTP.md`.

---

### Task 10: Live install and probes (no client switch)

- [ ] **Step 1: Pre-checks.** `npx tsx scripts/audit-archive-paths.mjs` against the live index → 0 paths outside roots (if not, stop and report). Verify the live schema with `openReadOnlyDatabase()` (no writes).
- [ ] **Step 2: Install.** `python3 scripts/manage-local-service.py install` → native probe ok, offline model load ok, probe `modern: ok`, `legacy: ok`, read ok; record latencies.
- [ ] **Step 3: launchd recovery (Review Focus 6).** `kill -TERM <service pid>` → within 10 s `launchctl print` shows a new pid and `probe` passes.
- [ ] **Step 4: Real clients, configs untouched (G1-13).**
  - Codex: temporary `CODEX_HOME` (0700) containing a 0600 `config.toml` with only the switched `[mcp_servers.episodic-memory]` block (token in `http_headers` in that file, not argv), `model`/`sandbox_mode` copied, and `auth.json` as a **symlink** to `~/.codex/auth.json` (per CLAUDE.md); `CODEX_HOME=<tmp> codex exec --skip-git-repo-check -s read-only "Use the episodic-memory search tool for 'LaunchAgent' (response_format json) and report only the count."` → count > 0. Delete the temp home afterwards.
  - Claude: `scripts/claude-plugin-http-probe.sh --live` against port 8734 using the real helper.
- [ ] **Step 5: Parity.** For 3 fixed queries × {text, vector, both} and a `read` of the first result: live HTTP output vs a stdio instance of the same build (`node dist/mcp-server.js`, read-only not required) → identical text (G1-18).
- [ ] **Step 6: Evidence** (redacted) to `~/repos/mcp-fleet-v2/evidence/<date>-episodic/`; add an "Episodic memory" section to `~/repos/mcp-fleet-v2/IMPLEMENTATION-STATUS.md`.
- [ ] **Step 7: STOP** — report to Gordon; `switch-clients` only on his approval.
