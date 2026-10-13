import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
import { lstat } from 'node:fs/promises';
import { readHttpConfig, startHttp } from '../src/http.js';
// @ts-expect-error plain .mjs script without type declarations
import { FIXTURE_DIR } from '../scripts/capture-mcp-baseline.mjs';

const token = 'test-only-not-a-real-credential-0123456789';
const workerPath = fileURLToPath(new URL('../dist/tool-worker.js', import.meta.url));
const slowExitWorker = fileURLToPath(new URL('./fixtures/workers/slow-exit-worker.mjs', import.meta.url));
const indexCli = fileURLToPath(new URL('../dist/index-cli.js', import.meta.url));

let root: string;
let tokenFile: string;
const savedEnv = { ...process.env };

function writeToken(mode: number, contents = token): string {
  const file = join(root, `token-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, contents);
  chmodSync(file, mode);
  return file;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'em-startup-'));
  for (const d of ['home', 'archive', 'config', 'projects/baseline-project']) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(FIXTURE_DIR, 'conversation.jsonl'), join(root, 'projects', 'baseline-project', 'session.jsonl'));
  tokenFile = writeToken(0o600);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'home'),
    EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config'),
    TEST_DB_PATH: join(root, 'db.sqlite'),
    TEST_ARCHIVE_DIR: join(root, 'archive'),
    TEST_PROJECTS_DIR: join(root, 'projects'),
  };
  delete env.EPISODIC_MEMORY_DB_PATH;
  const index = spawnSync(process.execPath, [indexCli, 'index-all', '--no-summaries'], { env, encoding: 'utf8' });
  if (index.status !== 0) throw new Error(`indexing failed: ${index.stdout}\n${index.stderr}`);
  Object.assign(process.env, env);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv, {
    HOME: join(root, 'home'),
    EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config'),
    TEST_DB_PATH: join(root, 'db.sqlite'),
    TEST_ARCHIVE_DIR: join(root, 'archive'),
    TEST_PROJECTS_DIR: join(root, 'projects'),
  });
  delete process.env.EPISODIC_MEMORY_DB_PATH;
});

describe('readHttpConfig', () => {
  const base = () => ({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: tokenFile });

  it('accepts a 0600 token file and applies defaults', async () => {
    delete process.env.VITEST;
    try {
      expect(await readHttpConfig(base())).toEqual({ port: 8734, token, workers: 3, deadlineMs: 100_000 });
    } finally {
      process.env.VITEST = 'true';
    }
  });

  it('tolerates one trailing newline in the token file', async () => {
    const file = writeToken(0o600, `${token}\n`);
    expect((await readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: file })).token).toBe(token);
  });

  it('rejects a missing env var, a missing file, a directory and a symlink', async () => {
    await expect(readHttpConfig({})).rejects.toThrow(/TOKEN_FILE is required/);
    await expect(readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: join(root, 'nope') })).rejects.toThrow(/cannot be read/);
    await expect(readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: root })).rejects.toThrow(/regular file/);
    const link = join(root, 'token-link');
    symlinkSync(tokenFile, link);
    await expect(readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: link })).rejects.toThrow(/regular file/);
  });

  it('requires mode exactly 0600', async () => {
    for (const mode of [0o640, 0o400, 0o644, 0o700]) {
      const file = writeToken(mode);
      await expect(readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: file })).rejects.toThrow(/mode 0600/);
    }
  });

  it('rejects a file owned by another uid', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(lstat).mockImplementationOnce((async (path: string) => {
      const info = await actual.lstat(path);
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: process.getuid!() + 1 });
    }) as never);
    await expect(readHttpConfig(base())).rejects.toThrow(/owned by the current user/);
  });

  it('rejects short or whitespace-containing tokens without echoing them', async () => {
    await expect(readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: writeToken(0o600, 'short') })).rejects.toThrow(/32 bytes/);
    const spaced = `${token} ${token}`;
    const error = await readHttpConfig({ EPISODIC_MEMORY_HTTP_TOKEN_FILE: writeToken(0o600, spaced) }).catch((e) => e);
    expect(error.message).toMatch(/without whitespace/);
    expect(error.message).not.toContain(token);
  });

  it('validates the port; 0 only under vitest', async () => {
    for (const port of ['80', '1023', '70000', '65536', 'abc', '-1', '8734.5']) {
      await expect(readHttpConfig({ ...base(), EPISODIC_MEMORY_HTTP_PORT: port })).rejects.toThrow(/PORT/);
    }
    expect((await readHttpConfig({ ...base(), EPISODIC_MEMORY_HTTP_PORT: '1024' })).port).toBe(1024);
    expect((await readHttpConfig({ ...base(), EPISODIC_MEMORY_HTTP_PORT: '65535' })).port).toBe(65535);
    expect((await readHttpConfig({ ...base(), EPISODIC_MEMORY_HTTP_PORT: '0' })).port).toBe(0);
    delete process.env.VITEST;
    try {
      await expect(readHttpConfig({ ...base(), EPISODIC_MEMORY_HTTP_PORT: '0' })).rejects.toThrow(/PORT/);
    } finally {
      process.env.VITEST = 'true';
    }
  });

  it('validates workers (1-8) and deadline (>= 1000 ms)', async () => {
    for (const workers of ['0', '9', 'x']) {
      await expect(readHttpConfig({ ...base(), EPISODIC_MEMORY_HTTP_WORKERS: workers })).rejects.toThrow(/WORKERS/);
    }
    expect((await readHttpConfig({ ...base(), EPISODIC_MEMORY_HTTP_WORKERS: '8' })).workers).toBe(8);
    expect((await readHttpConfig({ ...base(), EPISODIC_MEMORY_HTTP_WORKERS: '1' })).workers).toBe(1);
    await expect(readHttpConfig({ ...base(), EPISODIC_MEMORY_TOOL_DEADLINE_MS: '999' })).rejects.toThrow(/DEADLINE/);
    await expect(readHttpConfig({ ...base(), EPISODIC_MEMORY_TOOL_DEADLINE_MS: 'x' })).rejects.toThrow(/DEADLINE/);
    expect((await readHttpConfig({ ...base(), EPISODIC_MEMORY_TOOL_DEADLINE_MS: '1000' })).deadlineMs).toBe(1000);
  });
});

describe('startHttp', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (open.length) await open.pop()!().catch(() => {});
  });

  async function start(extra: Record<string, string> = {}) {
    Object.assign(process.env, {
      EPISODIC_MEMORY_HTTP_TOKEN_FILE: tokenFile,
      EPISODIC_MEMORY_HTTP_PORT: '0',
      EPISODIC_MEMORY_HTTP_WORKERS: '1',
      ...extra,
    });
    const service = await startHttp({ workerPath });
    open.push(() => service.close());
    const client = new Client({ name: 'startup-test', version: '1' });
    open.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return { service, client };
  }
  const textOf = (r: object) => ((r as { content: Array<{ text: string }> }).content[0].text);
  const search = (client: Client, mode: string) =>
    client.callTool({ name: 'search', arguments: { query: 'zebra widget cache', mode, response_format: 'json' } });

  it('serves text search immediately but reports vector search unavailable when embeddings cannot load', async () => {
    const { service, client } = await start({ EPISODIC_MEMORY_FORCE_EMBEDDINGS_UNAVAILABLE: '1' });
    const started = Date.now();
    const text = await search(client, 'text');
    expect(text.isError).toBeFalsy();
    expect(textOf(text)).toContain('zebra');
    expect(Date.now() - started).toBeLessThan(5000);
    const vector = await search(client, 'vector');
    expect(vector.isError).toBe(true);
    expect(textOf(vector)).toMatch(/Embeddings disabled by EPISODIC_MEMORY_FORCE_EMBEDDINGS_UNAVAILABLE/);

    // An unauthenticated request is refused.
    const res = await fetch(`http://127.0.0.1:${service.port}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  }, 60000);

  it('never lets background warm-up gate serving', async () => {
    const { client } = await start({ EPISODIC_MEMORY_TEST_WARM_DELAY_MS: '120000' });
    const started = Date.now();
    const text = await search(client, 'text');
    expect(text.isError).toBeFalsy();
    expect(Date.now() - started).toBeLessThan(2000);
  }, 60000);

  it('close() is idempotent and settles with the listener gone', async () => {
    const { service } = await start();
    await service.close();
    await service.close();
    await expect(fetch(`http://127.0.0.1:${service.port}/mcp`, { method: 'POST' })).rejects.toThrow();
  }, 60000);

  it('rejects when the port is already taken and leaves nothing running', async () => {
    const first = await start();
    Object.assign(process.env, { EPISODIC_MEMORY_HTTP_PORT: String(first.service.port) });
    await expect(startHttp({ workerPath })).rejects.toThrow(/EADDRINUSE/);
  }, 60000);

  it('bounds the pool close after a failed listen', async () => {
    const first = await start();
    Object.assign(process.env, { EPISODIC_MEMORY_HTTP_PORT: String(first.service.port) });
    const t0 = Date.now();
    await expect(startHttp({ workerPath: slowExitWorker, poolCloseBoundMs: 300 })).rejects.toThrow(/EADDRINUSE/);
    // The fixture worker takes 3 s to exit; the failed start must not wait for it.
    expect(Date.now() - t0).toBeLessThan(2000);
    await new Promise((resolve) => setTimeout(resolve, 3200)); // let the fixture worker exit
  }, 60000);
});
