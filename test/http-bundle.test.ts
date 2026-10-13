import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// @ts-expect-error plain .mjs script without type declarations
import { FIXTURE_DIR, FIXTURE_FILES } from '../scripts/capture-mcp-baseline.mjs';

const token = 'test-only-not-a-real-credential-0123456789';
const server = fileURLToPath(new URL('../dist/mcp-server.js', import.meta.url));
const indexCli = fileURLToPath(new URL('../dist/index-cli.js', import.meta.url));
const fixture = (file: string) => readFileSync(join(FIXTURE_DIR, file), 'utf8');

let root: string;
let child: ChildProcess | undefined;
let exited: Promise<number | string> | undefined;
let url: URL;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const norm = (text: string) =>
  [...new Set([root, realpathSync(root)])]
    .sort((a, b) => b.length - a.length)
    .reduce((t, f) => t.split(f).join('<ROOT>'), text)
    .replace(/("id": ")[0-9a-f]{32}(")/g, '$1<ID>$2');
const textOf = (r: object) => {
  const result = r as { isError?: boolean; content: Array<{ text: string }> };
  if (result.isError) throw new Error(`tool call failed: ${JSON.stringify(result)}`);
  return norm(result.content[0].text);
};
const pick = (t: Record<string, unknown>) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: t.annotations,
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'em-bundle-'));
  for (const d of ['home', 'archive', 'config', 'projects/baseline-project']) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(FIXTURE_DIR, 'conversation.jsonl'), join(root, 'projects', 'baseline-project', 'session.jsonl'));
  const tokenFile = join(root, 'token');
  writeFileSync(tokenFile, token);
  chmodSync(tokenFile, 0o600);

  const port = await freePort();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // VITEST must not leak: it disables signal handlers and allows port 0.
    if (v !== undefined && k !== 'VITEST' && !k.startsWith('VITEST_') && !k.startsWith('EPISODIC_MEMORY_') && !k.startsWith('TEST_')) env[k] = v;
  }
  Object.assign(env, {
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config'),
    TEST_DB_PATH: join(root, 'db.sqlite'),
    TEST_ARCHIVE_DIR: join(root, 'archive'),
    TEST_PROJECTS_DIR: join(root, 'projects'),
  });
  const index = spawnSync(process.execPath, [indexCli, 'index-all', '--no-summaries'], { env, encoding: 'utf8' });
  if (index.status !== 0) throw new Error(`indexing failed (${index.status}): ${index.stdout}\n${index.stderr}`);

  Object.assign(env, {
    EPISODIC_MEMORY_HTTP_TOKEN_FILE: tokenFile,
    EPISODIC_MEMORY_HTTP_PORT: String(port),
    EPISODIC_MEMORY_HTTP_WORKERS: '2',
  });
  child = spawn(process.execPath, [server, '--http'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  exited = new Promise((resolve) => child!.once('exit', (code, signal) => resolve(code ?? `signal:${signal}`)));
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`no HTTP ready line in 30 s; stderr:\n${stderr}`)), 30_000);
    child!.once('exit', (code) => reject(new Error(`server exited early (${code}); stderr:\n${stderr}`)));
    child!.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes('HTTP ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  url = new URL(`http://127.0.0.1:${port}/mcp`);
}, 60_000);

afterAll(() => {
  child?.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

describe('bundled dist/mcp-server.js --http', () => {
  it('serves both tools to modern and legacy clients matching the baseline, then exits 0 on SIGTERM', async () => {
    const headers = { Authorization: `Bearer ${token}` };
    const modern = new ModernClient({ name: 'bundle-modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await modern.connect(new ModernTransport(url, { requestInit: { headers } }));
    const legacy = new LegacyClient({ name: 'bundle-legacy', version: '1' });
    await legacy.connect(new LegacyTransport(url, { requestInit: { headers } }));
    try {
      const baselineTools = JSON.parse(fixture(FIXTURE_FILES.catalog)).tools as Array<Record<string, unknown>>;
      const readPath = join(root, 'archive', 'baseline-project', 'session.jsonl');
      for (const client of [modern, legacy]) {
        expect((await client.listTools()).tools.map(pick)).toEqual(baselineTools.map(pick));
        const json = await client.callTool({ name: 'search', arguments: { query: 'zebra widget cache', mode: 'text', response_format: 'json' } });
        expect(textOf(json)).toBe(fixture(FIXTURE_FILES.searchJson));
        const md = await client.callTool({ name: 'search', arguments: { query: 'zebra widget cache', mode: 'text', response_format: 'markdown' } });
        expect(textOf(md)).toBe(fixture(FIXTURE_FILES.searchMarkdown));
        const read = await client.callTool({ name: 'read', arguments: { path: readPath, startLine: 1, endLine: 3 } });
        expect(textOf(read)).toBe(fixture(FIXTURE_FILES.read));
      }
    } finally {
      await modern.close().catch(() => {});
      await legacy.close().catch(() => {});
    }

    child!.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 120_000);
});
