# Shared Stateless HTTP for episodic-memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve episodic-memory's `search`/`read` MCP tools from one shared, stateless Streamable-HTTP process (MCP 2026-07-28, TypeScript SDK v2) on 127.0.0.1:8734, so Claude and Codex sessions stop spawning ~108 per-session stdio servers.

**Architecture:** Extract the SDK-agnostic tool surface (`mcp-tools.ts`) from `mcp-server.ts`; build a v2 low-level `Server` factory over it; expose it via stdio (`serveStdio`) and via an HTTP boundary (`http.ts`) that mirrors `~/repos/outlook-mcp-v2/src/http.ts`. A Python management script installs a LaunchAgent, probes it, and switches/rolls back client configs.

**Tech Stack:** TypeScript (ESM, tsc + esbuild bundle to `dist/mcp-server.js`), `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/node` 2.1.1, `@modelcontextprotocol/client` 2.3.1 (dev), v1 `@modelcontextprotocol/sdk` kept as dev dependency for legacy-client tests, vitest, Python 3 for service management, macOS launchd.

**Spec:** `docs/superpowers/specs/2026-10-13-stateless-http-v2-design.md`

## Global Constraints

- Worktree `~/repos/episodic-memory-v2`, branch `feat/stateless-http-v2`, based on upstream `main` 7e06519. Never touch `~/repos/episodic-memory` (other branch in progress).
- Follow `CLAUDE.md`: edit `src/`, run `npm run build`, commit `dist/` with `src/`; never edit `src/version.ts`; tests isolate paths with `TEST_DB_PATH`/`TEST_ARCHIVE_DIR`/`TEST_PROJECTS_DIR`/`EPISODIC_MEMORY_CONFIG_DIR` and never touch real `~/.config/superpowers/`.
- SDK pins (exact): `@modelcontextprotocol/server@2.3.1`, `@modelcontextprotocol/node@2.1.1`, `@modelcontextprotocol/client@2.3.1`. Node ≥ 20 (service runtime: `~/.local/share/episodic-memory/runtime/node-v24.21.0-darwin-arm64/bin/node`).
- Tool names `search` and `read`, their JSON input schemas, annotations, descriptions and output text are unchanged byte-for-byte.
- HTTP: bind `127.0.0.1` only; port 8734 default (env `EPISODIC_MEMORY_HTTP_PORT`, 1024–65535); bearer from `EPISODIC_MEMORY_HTTP_TOKEN_FILE` (mode must be 0600, token ≥ 32 bytes, no whitespace); `POST /mcp` only; body ≤ 1 MiB; ≤ 16 concurrent requests; `requestTimeout` 125 s (Codex `tool_timeout_sec` is 120); `legacy: "stateless"`, `maxSubscriptions: 0`.
- Service: label `com.local.episodic-memory-v2`; state/logs/token under `~/.local/share/mcp-fleet/episodic-memory/` (dir 0700, files 0600).
- Live client configs (`~/.claude.json`, plugin cache manifests, `~/.codex/config.toml`) are changed ONLY by `switch-clients`, and only after Gordon approves. No running session is killed.

## Review Focus

1. **A slow search blocks every client.** `better-sqlite3` is synchronous, so one long vector/text query on the 4.1 GB DB stalls the event loop for all callers. Expect: other requests still complete (later), nothing crashes, the 16-request cap returns 503 rather than queueing unboundedly. Test: Task 4 "concurrency cap returns 503 and recovers".
2. **`read` path escapes.** `..` segments, symlinks pointing outside the roots, prefix tricks (`/archive-evil/x.jsonl` vs root `/archive`), relative paths, non-`.jsonl` files. Expect: refused with a clear error, never file contents. Test: Task 2.
3. **Embedding model unavailable at startup** (offline, cache missing). Expect: service still starts and text search works; vector search returns the existing error text. Test: Task 5 "warm-up failure does not stop the server".
4. **Legacy (2025-era) clients**, which Claude Code and Codex currently are. Expect: `initialize` works without a session ID and tools list/call succeed. Test: Task 4 legacy client cases, Task 8 real-client probes.
5. **Config drift between switch and rollback** (user edits `~/.codex/config.toml` after switching). Expect: rollback refuses to overwrite and explains; never clobbers unrelated settings. Test: Task 6 rollback-refusal test.
6. **Service down when a Claude session starts.** Claude retries HTTP servers 5 times (1→16 s) then marks them failed until `/mcp` reconnect (documented behaviour). Expect: launchd `KeepAlive` restarts the service; `STATELESS-HTTP.md` states the `/mcp` reconnect remedy. Test: Task 8 Step 1 kills the service process and confirms launchd restarts it within 10 s.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/mcp-tools.ts` (create) | SDK-agnostic tool surface: `TOOL_DEFINITIONS`, zod input schemas, `callTool(name, args, options)` |
| `src/read-policy.ts` (create) | `getReadableRoots()`, `resolveReadablePath(path, roots)` |
| `src/mcp-factory.ts` (create) | `createEpisodicServer(options)` → SDK v2 low-level `Server` |
| `src/http.ts` (create) | `createEpisodicHttpServer(token, factory)`, `startHttp()` |
| `src/mcp-server.ts` (modify) | Entry point: stdio by default, `--http` → `startHttp()` |
| `scripts/manage-local-service.py` (create) | `install`, `probe`, `status`, `switch-clients`, `rollback` |
| `scripts/probe-live.mjs` (create) | Modern + legacy HTTP probe of the live service |
| `scripts/test_manage_local_service.py` (create) | Unit tests for config edits / rollback guards |
| `STATELESS-HTTP.md` (create) | Operator doc, mirrors Outlook's |
| `test/mcp-tools.test.ts`, `test/read-policy.test.ts`, `test/http.test.ts` (create) | New tests |
| `test/mcp-server.test.ts` (modify) | Keep v1 stdio client test; add v2 modern stdio client |

---

### Task 1: Extract the SDK-agnostic tool surface

**Files:**
- Create: `src/mcp-tools.ts`
- Modify: `src/mcp-server.ts` (import from `mcp-tools.ts`; still SDK v1 in this task)
- Test: `test/mcp-tools.test.ts`

**Interfaces:**
- Produces:
  - `export const TOOL_DEFINITIONS: ToolDefinition[]` — exactly the two objects currently returned by the `ListToolsRequestSchema` handler (lines 143–199 of today's `src/mcp-server.ts`), moved verbatim.
  - `export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> & { type: 'object' }; annotations: Record<string, boolean | string> }`
  - `export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }`
  - `export type ToolCallOptions = { resolveReadPath?: (requested: string) => string }` — when set, `read` calls it and reads the returned path; when unset, `read` keeps today's `fs.existsSync` check.
  - `export async function callTool(name: string, args: unknown, options?: ToolCallOptions): Promise<ToolResult>` — the body of today's `CallToolRequestSchema` handler (lines 206–323), moved verbatim except `read` uses `options.resolveReadPath`.

- [ ] **Step 1: Write the failing test** — `test/mcp-tools.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'em-tools-'));
  for (const d of ['archive', 'projects', 'config']) mkdirSync(join(root, d), { recursive: true });
  process.env.TEST_DB_PATH = join(root, 'db.sqlite');
  process.env.TEST_ARCHIVE_DIR = join(root, 'archive');
  process.env.TEST_PROJECTS_DIR = join(root, 'projects');
  process.env.EPISODIC_MEMORY_CONFIG_DIR = join(root, 'config');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('mcp-tools', () => {
  it('defines exactly search and read with unchanged schemas', async () => {
    const { TOOL_DEFINITIONS } = await import('../src/mcp-tools.js');
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(['search', 'read']);
    expect(TOOL_DEFINITIONS[0].inputSchema).toMatchObject({
      type: 'object', required: ['query'], additionalProperties: false,
      properties: { query: { oneOf: [{ type: 'string', minLength: 2 }, { type: 'array', minItems: 2, maxItems: 5 }] } },
    });
    expect(TOOL_DEFINITIONS[1].inputSchema).toMatchObject({ required: ['path'], additionalProperties: false });
  });

  it('returns errors in-band for unknown tools and bad input', async () => {
    const { callTool } = await import('../src/mcp-tools.js');
    expect(await callTool('nope', {})).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: Unknown tool: nope' }] });
    expect((await callTool('search', { query: 'x' })).isError).toBe(true);
  });

  it('read uses resolveReadPath when provided', async () => {
    const { callTool } = await import('../src/mcp-tools.js');
    const file = join(root, 'archive', 'c.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-10-13T00:00:00Z' }) + '\n');
    const seen: string[] = [];
    const result = await callTool('read', { path: '/not/real.jsonl' }, { resolveReadPath: (p) => { seen.push(p); return file; } });
    expect(seen).toEqual(['/not/real.jsonl']);
    expect(result.isError).toBeFalsy();
    const refused = await callTool('read', { path: file }, { resolveReadPath: () => { throw new Error('Path is outside the conversation archive and transcript directories'); } });
    expect(refused).toMatchObject({ isError: true, content: [{ text: 'Error: Path is outside the conversation archive and transcript directories' }] });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/mcp-tools.test.ts` → FAIL (cannot resolve `../src/mcp-tools.js`).

- [ ] **Step 3: Implement.** Create `src/mcp-tools.ts`: move the zod schemas (`SearchModeEnum`, `ResponseFormatEnum`, `SearchInputSchema`, `ShowConversationInputSchema`), `handleError`, the two tool definition objects (as `TOOL_DEFINITIONS`), and the call-handler body (as `callTool`) out of `src/mcp-server.ts` unchanged. The only behavioural edit is in `read`:

```ts
if (name === 'read') {
  const params = ShowConversationInputSchema.parse(args);
  const target = options.resolveReadPath ? options.resolveReadPath(params.path) : params.path;
  if (!options.resolveReadPath && !fs.existsSync(target)) {
    throw new Error(`File not found: ${params.path}`);
  }
  const jsonlContent = fs.readFileSync(target, 'utf-8');
  const markdownContent = formatConversationAsMarkdown(jsonlContent, params.startLine, params.endLine);
  return { content: [{ type: 'text', text: markdownContent }] };
}
```

`callTool` signature: `export async function callTool(name: string, args: unknown, options: ToolCallOptions = {}): Promise<ToolResult>` wrapping everything in the existing try/catch that returns `{ content: [{ type: 'text', text: handleError(error) }], isError: true }`. In `src/mcp-server.ts`, replace the moved code with `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }))` and `server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(request.params.name, request.params.arguments))` (still SDK v1 here).

- [ ] **Step 4: Verify** — `npx vitest run test/mcp-tools.test.ts test/mcp-server.test.ts` → PASS (build first: `npm run build`, because `mcp-server.test.ts` runs `dist/mcp-server.js`). Then full `npm test` → PASS.

- [ ] **Step 5: Commit** — `git add src/mcp-tools.ts src/mcp-server.ts dist test/mcp-tools.test.ts && git commit -m "refactor: extract SDK-agnostic MCP tool surface"`

---

### Task 2: `read` path policy

**Files:**
- Create: `src/read-policy.ts`
- Test: `test/read-policy.test.ts`

**Interfaces:**
- Consumes: `getArchiveDir(): string`, `getConversationSourceDirs(only?): string[]` from `src/paths.ts`.
- Produces:
  - `export function getReadableRoots(): string[]` — realpaths of archive + source dirs that exist, deduplicated.
  - `export function resolveReadablePath(requested: string, roots: string[] = getReadableRoots()): string` — returns the realpath or throws one of: `Path must be absolute`, `File not found: <requested>`, `Only .jsonl conversation files can be read`, `Path is outside the conversation archive and transcript directories`.

- [ ] **Step 1: Write the failing test** — `test/read-policy.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReadablePath } from '../src/read-policy.js';

let base: string, archive: string, outside: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'em-policy-')));
  archive = join(base, 'archive'); outside = join(base, 'archive-evil');
  mkdirSync(join(archive, 'p'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(archive, 'p', 'ok.jsonl'), '{}\n');
  writeFileSync(join(archive, 'p', 'notes.txt'), 'x');
  writeFileSync(join(outside, 'x.jsonl'), '{}\n');
  writeFileSync(join(base, 'secret.jsonl'), '{}\n');
  symlinkSync(join(base, 'secret.jsonl'), join(archive, 'p', 'link.jsonl'));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('resolveReadablePath', () => {
  const roots = () => [archive];
  it('allows a .jsonl inside a root', () => {
    expect(resolveReadablePath(join(archive, 'p', 'ok.jsonl'), roots())).toBe(join(archive, 'p', 'ok.jsonl'));
  });
  it('refuses relative paths', () => {
    expect(() => resolveReadablePath('p/ok.jsonl', roots())).toThrow('Path must be absolute');
  });
  it('refuses missing files', () => {
    expect(() => resolveReadablePath(join(archive, 'nope.jsonl'), roots())).toThrow('File not found');
  });
  it('refuses non-jsonl files', () => {
    expect(() => resolveReadablePath(join(archive, 'p', 'notes.txt'), roots())).toThrow('Only .jsonl');
  });
  it('refuses .. escapes, sibling-prefix dirs and symlinks out of the root', () => {
    for (const p of [join(archive, '..', 'secret.jsonl'), join(outside, 'x.jsonl'), join(archive, 'p', 'link.jsonl')]) {
      expect(() => resolveReadablePath(p, roots())).toThrow('outside the conversation archive');
    }
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run test/read-policy.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `src/read-policy.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';
import { getArchiveDir, getConversationSourceDirs } from './paths.js';

export function getReadableRoots(): string[] {
  const roots = new Set<string>();
  for (const dir of [getArchiveDir(), ...getConversationSourceDirs()]) {
    try { roots.add(fs.realpathSync(dir)); } catch { /* source dir absent on this machine */ }
  }
  return [...roots];
}

export function resolveReadablePath(requested: string, roots: string[] = getReadableRoots()): string {
  if (!path.isAbsolute(requested)) throw new Error('Path must be absolute');
  let real: string;
  try { real = fs.realpathSync(requested); } catch { throw new Error(`File not found: ${requested}`); }
  if (!fs.statSync(real).isFile() || path.extname(real) !== '.jsonl') {
    throw new Error('Only .jsonl conversation files can be read');
  }
  if (!roots.some((root) => real.startsWith(root + path.sep))) {
    throw new Error('Path is outside the conversation archive and transcript directories');
  }
  return real;
}
```

- [ ] **Step 4: Verify** — `npx vitest run test/read-policy.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add src/read-policy.ts test/read-policy.test.ts && git commit -m "feat: confine shared read to conversation archive and transcript dirs"`

---

### Task 3: Port to SDK v2 (`Server` factory + stdio entry)

**Files:**
- Modify: `package.json` (deps), `package-lock.json`
- Create: `src/mcp-factory.ts`
- Modify: `src/mcp-server.ts` (entry only)
- Modify: `test/mcp-server.test.ts` (add modern stdio client)

**Interfaces:**
- Consumes: `TOOL_DEFINITIONS`, `callTool`, `ToolCallOptions` (Task 1); `VERSION` from `./version.js`.
- Produces: `export function createEpisodicServer(options?: ToolCallOptions): Server` (v2 `Server` from `@modelcontextprotocol/server`).

- [ ] **Step 1: Dependencies** — `npm install --save-exact @modelcontextprotocol/server@2.3.1 @modelcontextprotocol/node@2.1.1 && npm install --save-exact --save-dev @modelcontextprotocol/client@2.3.1` and move `@modelcontextprotocol/sdk` from `dependencies` to `devDependencies` (`npm install --save-dev @modelcontextprotocol/sdk@^1.20.0`). Confirm `grep -rn "@modelcontextprotocol/sdk" src` returns only `src/mcp-server.ts` (removed in Step 4).

- [ ] **Step 2: Failing test** — append to `test/mcp-server.test.ts`:

```ts
import { Client as ModernClient, StdioClientTransport as ModernStdio } from '@modelcontextprotocol/client';

describe('MCP stdio with an SDK v2 client', () => {
  it('lists the same two tools as the legacy client', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'episodic-memory-mcp-v2-'));
    mkdirSync(join(dir, 'archive'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    const c = new ModernClient({ name: 'v2-test', version: '1' });
    const transport = new ModernStdio({ command: process.execPath, args: [serverPath], stderr: 'pipe', env: buildMcpTestEnv(dir) });
    try {
      await c.connect(transport);
      const tools = await c.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(['search', 'read']);
    } finally {
      await c.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Run `npm run build && npx vitest run test/mcp-server.test.ts` → the new case may already pass against v1 (v2 clients fall back); that is acceptable. The gate is Step 4 keeping BOTH cases green after the port.

- [ ] **Step 3: Implement** — `src/mcp-factory.ts`

```ts
import { Server } from '@modelcontextprotocol/server';
import { TOOL_DEFINITIONS, callTool, type ToolCallOptions } from './mcp-tools.js';
import { VERSION } from './version.js';

export function createEpisodicServer(options: ToolCallOptions = {}): Server {
  const server = new Server(
    { name: 'episodic-memory', version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler('tools/list', async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler('tools/call', async (request) =>
    callTool(request.params.name, request.params.arguments, options),
  );
  return server;
}
```

If the v2 types reject `TOOL_DEFINITIONS` as `Tool[]`, type `ToolDefinition` in `mcp-tools.ts` as `Tool` imported with `import type { Tool } from '@modelcontextprotocol/server'` — do not cast through `any`.

- [ ] **Step 4: Replace the entry point** — `src/mcp-server.ts` becomes:

```ts
#!/usr/bin/env node
/**
 * MCP Server for Episodic Memory. stdio by default; `--http` serves the shared
 * stateless HTTP endpoint (see STATELESS-HTTP.md).
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createEpisodicServer } from './mcp-factory.js';

async function main() {
  if (process.argv.includes('--http')) {
    const { startHttp } = await import('./http.js');
    await startHttp();
    return;
  }
  serveStdio(() => createEpisodicServer());
  console.error('Episodic Memory MCP server running via stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
```

Until Task 4 exists, create `src/http.ts` with `export async function startHttp(): Promise<void> { throw new Error('HTTP mode not built yet'); }` so the build compiles; Task 4 replaces it.

- [ ] **Step 5: Verify** — `npm run build && npm test` → PASS, including the original v1 `Client` cases and the new v2 case. `node dist/mcp-server.js < /dev/null` exits cleanly on EOF.
- [ ] **Step 6: Commit** — `git add package.json package-lock.json src dist test/mcp-server.test.ts && git commit -m "feat: serve MCP through TypeScript SDK v2 (stdio unchanged for clients)"`

---

### Task 4: HTTP boundary

**Files:**
- Modify: `src/http.ts` (replace stub)
- Test: `test/http.test.ts`

**Interfaces:**
- Consumes: `createEpisodicServer(options)` (Task 3), `resolveReadablePath` (Task 2).
- Produces:
  - `export function createEpisodicHttpServer(token: string, factory?: () => Server): { http: import('node:http').Server; close(): Promise<void> }` — default factory `() => createEpisodicServer({ resolveReadPath: (p) => resolveReadablePath(p) })`.
  - `export const MAX_BODY_BYTES = 1024 * 1024; export const MAX_CONCURRENT = 16;`

- [ ] **Step 1: Failing tests** — `test/http.test.ts`

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/server';
import { createEpisodicHttpServer } from '../src/http.js';

const token = 'test-only-not-a-real-credential-0123456789';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
let root: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'em-http-'));
  for (const d of ['archive', 'projects', 'config']) mkdirSync(join(root, d), { recursive: true });
  process.env.TEST_DB_PATH = join(root, 'db.sqlite');
  process.env.TEST_ARCHIVE_DIR = join(root, 'archive');
  process.env.TEST_PROJECTS_DIR = join(root, 'projects');
  process.env.EPISODIC_MEMORY_CONFIG_DIR = join(root, 'config');
  writeFileSync(join(root, 'archive', 'c.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello there' }, timestamp: '2026-10-13T00:00:00Z' }) + '\n');
  writeFileSync(join(root, 'outside.jsonl'), '{}\n');
});
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function fixture(factory?: () => Server) {
  const service = createEpisodicHttpServer(token, factory);
  await new Promise<void>((r) => service.http.listen(0, '127.0.0.1', r));
  cleanups.push(() => service.close());
  const { port } = service.http.address() as { port: number };
  return new URL(`http://127.0.0.1:${port}/mcp`);
}
async function client(url: URL, modern = true) {
  const c = modern
    ? new Client({ name: 'fixture', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
    : new LegacyClient({ name: 'legacy', version: '1' });
  const transport = modern ? new StreamableHTTPClientTransport(url, { requestInit: { headers } }) : new LegacyTransport(url, { requestInit: { headers } });
  await c.connect(transport as never);
  cleanups.push(() => c.close());
  expect(transport.sessionId).toBeUndefined();
  return c;
}

describe('episodic HTTP', () => {
  it('serves identical catalogs to two modern clients and one legacy client', async () => {
    const url = await fixture();
    const [a, b, legacy] = await Promise.all([client(url), client(url), client(url, false)]);
    const [ca, cb, cl] = await Promise.all([a.listTools(), b.listTools(), legacy.listTools()]);
    expect(ca.tools.map((t) => t.name)).toEqual(['search', 'read']);
    expect(ca.tools).toEqual(cb.tools);
    expect(ca.tools.map((t) => [t.name, t.inputSchema])).toEqual(cl.tools.map((t) => [t.name, t.inputSchema]));
  });

  it('runs search over HTTP', async () => {
    const c = await client(await fixture());
    const r = await c.callTool({ name: 'search', arguments: { query: 'hello there', mode: 'text', response_format: 'json' } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toMatchObject({ count: expect.any(Number), mode: 'text' });
  });

  it('confines read to the archive and transcript dirs', async () => {
    const c = await client(await fixture());
    const ok = await c.callTool({ name: 'read', arguments: { path: join(root, 'archive', 'c.jsonl') } });
    expect(ok.isError).toBeFalsy();
    for (const path of [join(root, 'outside.jsonl'), '/etc/hosts', join(root, 'archive', '..', 'outside.jsonl')]) {
      const r = await c.callTool({ name: 'read', arguments: { path } });
      expect(r.isError).toBe(true);
    }
  });

  it('rejects missing/wrong bearer, hostile host/origin, wrong method/path, malformed and oversized bodies', async () => {
    const url = await fixture();
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect([401, 403]).toContain((await fetch(url, { method: 'POST', headers: { ...headers, Authorization: 'Bearer wrong' }, body: '{}' })).status);
    expect((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: '{}' })).status).toBe(403);
    const hostile = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { ...headers, Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end('{}');
    });
    expect(hostile).toBe(403);
    expect((await fetch(url, { headers })).status).toBe(405);
    expect((await fetch(new URL('/other', url), { method: 'POST', headers, body: '{}' })).status).toBe(404);
    expect((await fetch(url, { method: 'POST', headers, body: '{broken' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
  });

  it('caps concurrency with 503 and recovers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = () => {
      const s = new Server({ name: 'slow', version: '1' }, { capabilities: { tools: {} } });
      s.setRequestHandler('tools/list', async () => { await gate; return { tools: [] }; });
      return s;
    };
    const url = await fixture(slow);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
    const inflight = Array.from({ length: 16 }, () => fetch(url, { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': '2026-07-28' }, body }));
    await new Promise((r) => setTimeout(r, 200));
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(503);
    release();
    await Promise.all(inflight);
    expect((await fetch(url, { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': '2026-07-28' }, body })).status).not.toBe(503);
  });

  it('refuses short or whitespace tokens at construction', () => {
    expect(() => createEpisodicHttpServer('short')).toThrow(/at least 32 bytes/);
    expect(() => createEpisodicHttpServer('x'.repeat(31) + ' y')).toThrow(/at least 32 bytes/);
  });
});
```

Note for the implementer: if the modern-envelope request shape in the concurrency test does not match SDK 2.3.1's classification, take the exact envelope from `node_modules/@modelcontextprotocol/server` docs/examples (`classifyInboundRequest`), keeping the test's intent: 16 requests held open, the 17th gets 503, service recovers.

- [ ] **Step 2: Run** — `npx vitest run test/http.test.ts` → FAIL (`createEpisodicHttpServer` not exported).

- [ ] **Step 3: Implement** — replace `src/http.ts` (structure copied from `~/repos/outlook-mcp-v2/src/http.ts`):

```ts
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, type Server } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createEpisodicServer } from './mcp-factory.js';
import { resolveReadablePath } from './read-policy.js';

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CONCURRENT = 16;

const sharedFactory = () => createEpisodicServer({ resolveReadPath: (p) => resolveReadablePath(p) });

export function createEpisodicHttpServer(token: string, factory: () => Server = sharedFactory) {
  if (Buffer.byteLength(token) < 32 || /\s/.test(token)) {
    throw new Error('HTTP bearer token must contain at least 32 bytes without whitespace.');
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const mcp = createMcpHandler(factory, {
    legacy: 'stateless',
    maxSubscriptions: 0,
    onerror: () => process.stderr.write('episodic-memory rejected a protocol request\n'),
  });
  const handle = toNodeHandler(mcp);
  const validHost = localhostHostValidation();
  const validOrigin = localhostOriginValidation();
  let active = 0;
  const http = createServer(async (req, res) => {
    if (!validHost(req, res) || !validOrigin(req, res)) return;
    const presented = Buffer.from(req.headers.authorization ?? '');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="episodic-memory"' }).end();
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (active >= MAX_CONCURRENT) { res.writeHead(503, { 'Retry-After': '1' }).end(); return; }
    active++;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
      await handle(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end(); else res.destroy();
    } finally {
      active--;
    }
  });
  http.requestTimeout = 125_000;
  http.headersTimeout = 10_000;
  return {
    http,
    close: async () => {
      await mcp.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

export async function startHttp(): Promise<void> {
  throw new Error('startHttp is implemented in Task 5');
}
```

Use the exact export names of `@modelcontextprotocol/node@2.1.1`; if `localhostHostValidation`/`localhostOriginValidation`/`toNodeHandler` are named differently in 2.1.1, check `node_modules/@modelcontextprotocol/node/dist/index.d.mts` and adapt (Outlook used 2.0.0).

- [ ] **Step 4: Verify** — `npx vitest run test/http.test.ts` → PASS; `npm run build && npm test` → PASS.
- [ ] **Step 5: Commit** — `git add src/http.ts test/http.test.ts dist && git commit -m "feat: authenticated stateless HTTP boundary for the shared server"`

---

### Task 5: `startHttp()` — config, warm-up, signals

**Files:**
- Modify: `src/http.ts` (`startHttp`, plus `export function readHttpConfig(env)`)
- Test: `test/http.test.ts` (append), `test/http-startup.test.ts` (create)

**Interfaces:**
- Consumes: `initEmbeddings(): Promise<void>` from `src/embeddings.ts`.
- Produces:
  - `export async function readHttpConfig(env: NodeJS.ProcessEnv): Promise<{ port: number; token: string }>` — throws `Shared HTTP requires EPISODIC_MEMORY_HTTP_TOKEN_FILE.`, `Bearer token file must be owner-only (0600).`, `Invalid EPISODIC_MEMORY_HTTP_PORT.`
  - `export async function startHttp(options?: { warm?: () => Promise<void> }): Promise<{ close(): Promise<void>; port: number }>`

- [ ] **Step 1: Failing tests** — `test/http-startup.test.ts`

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHttpConfig, startHttp } from '../src/http.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function tokenFile(mode: number) {
  const d = mkdtempSync(join(tmpdir(), 'em-start-')); dirs.push(d);
  const f = join(d, 'http-token'); writeFileSync(f, 'a'.repeat(48) + '\n'); chmodSync(f, mode); return f;
}

describe('readHttpConfig', () => {
  it('requires a token file', async () => {
    await expect(readHttpConfig({})).rejects.toThrow('requires EPISODIC_MEMORY_HTTP_TOKEN_FILE');
  });
  it('rejects group/world-readable token files', async () => {
    await expect(readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: tokenFile(0o644) })).rejects.toThrow('owner-only');
  });
  it('validates the port and defaults to 8734', async () => {
    const f = tokenFile(0o600);
    expect(await readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: f })).toEqual({ port: 8734, token: 'a'.repeat(48) });
    for (const p of ['80', '70000', 'abc']) {
      await expect(readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: f, EPISODIC_MEMORY_HTTP_PORT: p })).rejects.toThrow('Invalid EPISODIC_MEMORY_HTTP_PORT');
    }
  });
});

describe('startHttp', () => {
  it('keeps serving when embedding warm-up fails', async () => {
    process.env.EPISODIC_MEMORY_HTTP_TOKEN_FILE = tokenFile(0o600);
    process.env.EPISODIC_MEMORY_HTTP_PORT = '0';
    const svc = await startHttp({ warm: async () => { throw new Error('offline'); } });
    try {
      const r = await fetch(`http://127.0.0.1:${svc.port}/mcp`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(401);
    } finally { await svc.close(); delete process.env.EPISODIC_MEMORY_HTTP_PORT; }
  });
});
```

Port `0` is allowed ONLY when `NODE_ENV === 'test'` or `VITEST` is set (vitest sets `VITEST=true`); production validation is 1024–65535.

- [ ] **Step 2: Run** — `npx vitest run test/http-startup.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/http.ts`, replace the `startHttp` stub:

```ts
import { initEmbeddings } from './embeddings.js';

export async function readHttpConfig(env: NodeJS.ProcessEnv): Promise<{ port: number; token: string }> {
  const tokenFile = env.EPISODIC_MEMORY_HTTP_TOKEN_FILE;
  if (!tokenFile) throw new Error('Shared HTTP requires EPISODIC_MEMORY_HTTP_TOKEN_FILE.');
  const stat = await fs.stat(tokenFile);
  if ((stat.mode & 0o077) !== 0) throw new Error('Bearer token file must be owner-only (0600).');
  const raw = env.EPISODIC_MEMORY_HTTP_PORT ?? '8734';
  const port = Number(raw);
  const testPortZero = port === 0 && Boolean(env.VITEST);
  if (!/^\d+$/.test(raw) || !(testPortZero || (Number.isInteger(port) && port >= 1024 && port <= 65535))) {
    throw new Error('Invalid EPISODIC_MEMORY_HTTP_PORT.');
  }
  return { port, token: (await fs.readFile(tokenFile, 'utf8')).trim() };
}

export async function startHttp(options: { warm?: () => Promise<void> } = {}) {
  const { port, token } = await readHttpConfig(process.env);
  const warm = options.warm ?? initEmbeddings;
  const started = Date.now();
  try {
    await warm();
    process.stderr.write(`episodic-memory embeddings warm in ${Date.now() - started} ms\n`);
  } catch (error) {
    process.stderr.write(`episodic-memory embeddings unavailable at startup (text search still works): ${String(error)}\n`);
  }
  const service = createEpisodicHttpServer(token);
  await new Promise<void>((resolve, reject) => {
    service.http.once('error', reject);
    service.http.listen(port, '127.0.0.1', resolve);
  });
  const bound = (service.http.address() as { port: number }).port;
  if (!process.env.VITEST) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void service.close().then(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
      });
    }
  }
  process.stderr.write(`episodic-memory HTTP ready on 127.0.0.1:${bound}\n`);
  return { close: service.close, port: bound };
}
```

Update `src/mcp-server.ts` `--http` branch to `await startHttp();` (return value unused).

- [ ] **Step 4: Verify** — `npm run build && npm test` → PASS. Manual smoke: `umask 077; mkdir -p /tmp/em-smoke && head -c 48 /dev/urandom | base64 | tr -d '\n/+=' > /tmp/em-smoke/t; EPISODIC_MEMORY_HTTP_TOKEN_FILE=/tmp/em-smoke/t EPISODIC_MEMORY_HTTP_PORT=18734 TEST_DB_PATH=/tmp/em-smoke/db.sqlite TEST_ARCHIVE_DIR=/tmp/em-smoke/a TEST_PROJECTS_DIR=/tmp/em-smoke/p node dist/mcp-server.js --http` prints `HTTP ready`; Ctrl-C exits 0.
- [ ] **Step 5: Commit** — `git add src/http.ts src/mcp-server.ts dist test/http-startup.test.ts && git commit -m "feat: start the shared HTTP service with warm embeddings and safe config"`

---

### Task 6: Service management, probe and docs

**Files:**
- Create: `scripts/manage-local-service.py`, `scripts/test_manage_local_service.py`, `scripts/probe-live.mjs`, `STATELESS-HTTP.md`

**Interfaces:**
- Consumes: `dist/mcp-server.js --http` (Task 5).
- Produces (CLI): `python3 scripts/manage-local-service.py {install,probe,status,switch-clients,rollback} [--claude-mode plugin-manifest|user-scope]`.
- Produces (importable, for tests): `codex_switch(text: str, url: str, token: str) -> str`, `codex_restore(current: str, switched: str, original_block: str) -> str` (raises `DriftError`), `claude_manifest_switch(doc: dict, url: str, helper: str) -> dict`, `claude_user_scope_switch(doc: dict, url: str, helper: str) -> dict`, `HEADERS_HELPER` path constant.
- Claude never stores the bearer: entries use `headersHelper` (documented for plugin HTTP entries in Claude Code 2.1.296) pointing at `STATE/headers-helper.sh` (mode 0700), which prints `{"Authorization":"Bearer <contents of http-token>"}`. Codex has no helper mechanism, so its entry carries the token in `http_headers`, matching the existing Outlook entry in the same 0600 file.

Constants (top of script):

```python
HOME = Path.home()
REPO = Path(__file__).resolve().parent.parent
LABEL = "com.local.episodic-memory-v2"
PORT = 8734
URL = f"http://127.0.0.1:{PORT}/mcp"
STATE = HOME / ".local/share/mcp-fleet/episodic-memory"
TOKEN = STATE / "http-token"
LOG = STATE / "service.log"
RECORD = STATE / "switch-record.json"
HEADERS_HELPER = STATE / "headers-helper.sh"
PLIST = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
NODE = HOME / ".local/share/episodic-memory/runtime/node-v24.21.0-darwin-arm64/bin/node"
CODEX_CONFIG = HOME / ".codex/config.toml"
CLAUDE_JSON = HOME / ".claude.json"
PLUGIN_ROOT = HOME / ".claude/plugins/cache/superpowers-marketplace/episodic-memory"
EVIDENCE = HOME / "repos/mcp-fleet-v2/evidence" / f"{date.today()}-episodic"
```

Behaviour:
- `install`: refuse if `NODE` missing; `STATE.mkdir(mode=0o700, parents=True)`; create `TOKEN` with `secrets.token_urlsafe(48)` and `os.open(..., 0o600)` if absent (never overwrite); write `HEADERS_HELPER` (0700): `#!/bin/sh\nprintf '{"Authorization":"Bearer %s"}' "$(cat "$HOME/.local/share/mcp-fleet/episodic-memory/http-token")"\n`; `npm ci` then `npm run build` in `REPO` using `NODE`'s directory first on `PATH` (native modules must match the service runtime); seed the transformer model cache by copying `<latest plugin version>/node_modules/@huggingface/transformers/.cache/Xenova` into `REPO/node_modules/@huggingface/transformers/.cache/` if absent; write `PLIST` (ProgramArguments `[NODE, REPO/dist/mcp-server.js, --http]`, `EnvironmentVariables` = `EPISODIC_MEMORY_HTTP_TOKEN_FILE`, `EPISODIC_MEMORY_HTTP_PORT`, `HOME`, `PATH`), `RunAtLoad` and `KeepAlive` true, `StandardOutPath`/`StandardErrorPath` = `LOG`, `WorkingDirectory` = `REPO`; `launchctl bootout` (ignore failure) then `launchctl bootstrap gui/<uid> PLIST`; then run `probe`.
- `probe`: runs `NODE scripts/probe-live.mjs` with `EPISODIC_MEMORY_HTTP_TOKEN_FILE=TOKEN`; exit non-zero on any failure.
- `status`: `launchctl print gui/<uid>/LABEL` state + pid, port listener, last 20 log lines.
- `switch-clients`: requires a passing `probe`; copies `CODEX_CONFIG`, `CLAUDE_JSON` (user-scope mode) or the plugin manifests (`.mcp.json`, `.claude-plugin/plugin.json` of the latest version dir, manifest mode) to `EVIDENCE` with mode 0600; applies the edit; writes `RECORD` (mode 0600) with `{mode, files: {path: {original_sha256, switched_sha256, original_block}}}`; prints which sessions adopt on restart.
- `rollback`: for each file in `RECORD`, if current sha256 != `switched_sha256`, attempt a targeted restore of only the episodic entry (`codex_restore`/JSON key restore) and raise `DriftError` if the episodic entry itself was edited since switch; never rewrite unrelated content; leaves the service running and prints the `launchctl bootout` command.

Codex edit (`codex_switch`): within the block delimited by `[mcp_servers.episodic-memory]` and the next `[` table header, replace `command = ...` with `url = "<URL>"` and add `http_headers = { Authorization = "Bearer <token>" }`; keep `startup_timeout_sec` and `tool_timeout_sec` lines. Claude manifest edit (`claude_manifest_switch`): set `mcpServers["episodic-memory"] = {"type": "http", "url": URL, "headersHelper": str(HEADERS_HELPER)}` in both manifest files (`plugin.json` wins over `.mcp.json` when both define it; edit both so they agree). User-scope edit: set `doc["mcpServers"]["episodic-memory"]` the same way (Task 7 decides which mode is used).

- [ ] **Step 1: Failing tests** — `scripts/test_manage_local_service.py` (run with `python3 -m unittest scripts/test_manage_local_service.py`)

```python
import importlib.util, unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location("mls", Path(__file__).with_name("manage-local-service.py"))
mls = importlib.util.module_from_spec(spec); spec.loader.exec_module(mls)

CODEX = '''[mcp_servers.outlook]
url = "http://127.0.0.1:8733/mcp"

# --- episodic-memory block ---
[mcp_servers.episodic-memory]
command = "/Users/x/.codex/episodic-memory-launch.sh"
startup_timeout_sec = 90.0
tool_timeout_sec = 120.0

# --- end episodic-memory block ---
[mcp_servers.mongodb]
url = "http://127.0.0.1:3010/mcp"
'''
TOKEN = "t" * 48

class CodexEdits(unittest.TestCase):
    def test_switch_only_touches_episodic_block(self):
        out = mls.codex_switch(CODEX, mls.URL, TOKEN)
        self.assertIn('url = "http://127.0.0.1:8734/mcp"', out)
        self.assertIn(f'http_headers = {{ Authorization = "Bearer {TOKEN}" }}', out)
        self.assertNotIn("episodic-memory-launch.sh", out)
        self.assertIn("tool_timeout_sec = 120.0", out)
        self.assertEqual(out.replace(out[out.index("[mcp_servers.episodic-memory]"):out.index("# --- end")], ""),
                         CODEX.replace(CODEX[CODEX.index("[mcp_servers.episodic-memory]"):CODEX.index("# --- end")], ""))

    def test_restore_tolerates_unrelated_edits_and_refuses_episodic_drift(self):
        switched = mls.codex_switch(CODEX, mls.URL, TOKEN)
        block = mls.extract_block(CODEX)
        later = switched.replace('url = "http://127.0.0.1:3010/mcp"', 'url = "http://127.0.0.1:3011/mcp"')
        restored = mls.codex_restore(later, switched, block)
        self.assertIn("episodic-memory-launch.sh", restored)
        self.assertIn("3011", restored)
        drifted = switched.replace("tool_timeout_sec = 120.0", "tool_timeout_sec = 30.0")
        with self.assertRaises(mls.DriftError):
            mls.codex_restore(drifted, switched, block)

class ClaudeEdits(unittest.TestCase):
    def test_manifest_switch(self):
        doc = {"mcpServers": {"episodic-memory": {"command": "x", "args": ["mcp"]}}}
        out = mls.claude_manifest_switch(doc, mls.URL, "/h/helper.sh")
        self.assertEqual(out["mcpServers"]["episodic-memory"],
                         {"type": "http", "url": mls.URL, "headersHelper": "/h/helper.sh"})
        self.assertNotIn(TOKEN, repr(out))
        self.assertEqual(doc["mcpServers"]["episodic-memory"]["command"], "x")  # input not mutated

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run** — `python3 -m unittest scripts/test_manage_local_service.py` → FAIL (script missing).
- [ ] **Step 3: Implement** `scripts/manage-local-service.py` per the behaviour above (argparse subcommands; pure functions `extract_block(text) -> str` returning the `[mcp_servers.episodic-memory]` table through the line before the next table header or block-end comment, `codex_switch`, `codex_restore`, `claude_manifest_switch`, `claude_user_scope_switch`, class `DriftError(Exception)`; side-effecting commands only under `main()`). Implement `scripts/probe-live.mjs`:

```js
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.EPISODIC_MEMORY_URL ?? 'http://127.0.0.1:8734/mcp');
const token = (await readFile(process.env.EPISODIC_MEMORY_HTTP_TOKEN_FILE, 'utf8')).trim();
const requestInit = { headers: { Authorization: `Bearer ${token}` } };
for (const [label, c, t] of [
  ['modern', new Client({ name: 'probe', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } }), new StreamableHTTPClientTransport(url, { requestInit })],
  ['legacy', new LegacyClient({ name: 'probe-legacy', version: '1' }), new LegacyTransport(url, { requestInit })],
]) {
  await c.connect(t);
  const names = (await c.listTools()).tools.map((x) => x.name).join(',');
  if (names !== 'search,read') throw new Error(`${label}: unexpected tools ${names}`);
  const started = Date.now();
  const r = await c.callTool({ name: 'search', arguments: { query: 'episodic memory', limit: 3, response_format: 'json' } });
  if (r.isError) throw new Error(`${label}: search failed: ${r.content?.[0]?.text}`);
  console.log(`${label}: ok, search ${Date.now() - started} ms, ${JSON.parse(r.content[0].text).count} results`);
  await c.close();
}
```

Write `STATELESS-HTTP.md` mirroring `~/repos/outlook-mcp-v2/STATELESS-HTTP.md`: what it is, boundary list, `read` restriction, deployment table (worktree, endpoint, label, state, token, plist), commands (`install`, `probe`, `status`, `switch-clients`, `rollback`, `launchctl bootout gui/$(id -u)/com.local.episodic-memory-v2`), and the statement that existing sessions adopt on restart and nothing is force-killed.

- [ ] **Step 4: Verify** — `python3 -m unittest scripts/test_manage_local_service.py` → PASS; `python3 scripts/manage-local-service.py --help` lists the five subcommands; `npm test` still PASS.
- [ ] **Step 5: Commit** — `git add scripts/manage-local-service.py scripts/test_manage_local_service.py scripts/probe-live.mjs STATELESS-HTTP.md && git commit -m "feat: install, probe, switch and roll back the shared episodic service"`

---

### Task 7: Decide and wire the Claude client mechanism

**Files:**
- Create: `scripts/claude-plugin-http-probe.sh`
- Modify: `~/.local/bin/episodic-memory-patch` (back it up to `EVIDENCE` first; outside this repo)
- Modify: `STATELESS-HTTP.md` (record the decision)

**Interfaces:**
- Consumes: a running HTTP service (temporary instance on port 18734 with a scratch token is enough).
- Produces: decision `plugin-manifest` or `user-scope`, recorded in `STATELESS-HTTP.md`; `episodic-memory-patch` gains a `transport-http` step that, when `~/.local/share/mcp-fleet/episodic-memory/switch-record.json` says `mode == "plugin-manifest"`, re-applies `claude_manifest_switch` to a newly installed plugin version dir (and reports `transport-http: applied|present|not-switched` under `--check`).

- [ ] **Step 1: Probe script** — `scripts/claude-plugin-http-probe.sh`: create a temp plugin dir `em-http-probe` (`.claude-plugin/plugin.json` with `{"name":"em-http-probe","version":"0.0.0"}` and `.mcp.json` with `{"mcpServers":{"episodic-memory":{"type":"http","url":"http://127.0.0.1:18734/mcp","headersHelper":"$TMP/helper.sh"}}}` where `helper.sh` prints the scratch bearer as JSON), then run:

```bash
claude -p --plugin-dir "$TMP/em-http-probe" --strict-mcp-config --output-format json \
  --allowedTools "mcp__plugin_em-http-probe_episodic-memory__search" \
  "Call the search tool from the em-http-probe plugin with query 'probe check' and response_format json, then print only the count field."
```

Pass criteria: exit 0, the JSON result shows a tool call to `mcp__plugin_em-http-probe_episodic-memory__search`, and the service log shows an authenticated request. Also run the same with `headersHelper` removed and confirm the tool is unavailable (proves the header is actually sent and required).

- [ ] **Step 2: Decide** — if Step 1 passes: `plugin-manifest`. Otherwise: `user-scope`, and add to Task 6's `switch-clients` a patch of the plugin's `agents/search-conversations.md` `tools:` line from `mcp__plugin_episodic-memory_episodic-memory__*` to `mcp__episodic-memory__*` (backed up and restored by `rollback`). Record the evidence (commands + output) in `STATELESS-HTTP.md`.
- [ ] **Step 3: Patch persistence** — add the `transport-http` step to `episodic-memory-patch` (only for `plugin-manifest`). Test: copy the current plugin version dir to a temp root, run `EPISODIC_MEMORY_PLUGIN_ROOT=<tmp> episodic-memory-patch --check` before/after a simulated switch record → reports `not-switched`, then `applied` on a pristine copy, then `present`.
- [ ] **Step 4: Commit** — `git add scripts/claude-plugin-http-probe.sh STATELESS-HTTP.md && git commit -m "feat: verify and persist Claude plugin HTTP transport"` (the `~/.local/bin` change is recorded in `STATELESS-HTTP.md` with its backup path).

---

### Task 8: Install and probe the live service (no client switch)

- [ ] **Step 1:** `python3 scripts/manage-local-service.py install` → probe prints `modern: ok` and `legacy: ok` against the real 4.1 GB index; record search latency.
- [ ] **Step 2: Real clients against the service without changing their configs:**
  - Codex: `codex exec --skip-git-repo-check -s read-only -c 'mcp_servers.episodic-memory.url="http://127.0.0.1:8734/mcp"' -c 'mcp_servers.episodic-memory.http_headers={Authorization="Bearer <token>"}' -c 'mcp_servers.episodic-memory.command=null' "Use the episodic-memory search tool for 'LaunchAgent' and report the result count."` (if `command=null` is rejected, use a temporary `CODEX_HOME` copy of `~/.codex` with the switched block).
  - Claude: re-run `scripts/claude-plugin-http-probe.sh` against port 8734 with the real token.
- [ ] **Step 3: Parity** — for 3 fixed queries, compare `response_format: "json"` results from the live HTTP service and from a stdio instance (`node dist/mcp-server.js` via the v1 client) — identical `count` and result paths.
- [ ] **Step 4:** Write evidence to `~/repos/mcp-fleet-v2/evidence/<date>-episodic/` and update `~/repos/mcp-fleet-v2/IMPLEMENTATION-STATUS.md` with an "Episodic memory" section.
- [ ] **Step 5: STOP.** Report to Gordon and wait for approval before `switch-clients`.
