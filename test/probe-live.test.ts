import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startHttp } from '../src/http.js';
// @ts-expect-error plain .mjs script without type declarations
import { FIXTURE_DIR } from '../scripts/capture-mcp-baseline.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const probeScript = join(repo, 'scripts', 'probe-live.mjs');
const workerPath = join(repo, 'dist', 'tool-worker.js');
const token = 'test-only-not-a-real-credential-0123456789';
const ISOLATION = ['HOME', 'EPISODIC_MEMORY_CONFIG_DIR', 'TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'TEST_PROJECTS_DIR', 'EPISODIC_MEMORY_DB_PATH',
  'EPISODIC_MEMORY_HTTP_TOKEN_FILE', 'EPISODIC_MEMORY_HTTP_PORT', 'EPISODIC_MEMORY_HTTP_WORKERS', 'EPISODIC_MEMORY_FORCE_EMBEDDINGS_UNAVAILABLE'];

let root: string;
let tokenFile: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ISOLATION) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'em-probe-'));
  for (const d of ['home', 'archive', 'config', 'projects/baseline-project']) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(FIXTURE_DIR, 'conversation.jsonl'), join(root, 'projects', 'baseline-project', 'session.jsonl'));
  tokenFile = join(root, 'token');
  writeFileSync(tokenFile, token);
  chmodSync(tokenFile, 0o600);
  delete process.env.EPISODIC_MEMORY_DB_PATH;
  Object.assign(process.env, {
    HOME: join(root, 'home'),
    EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config'),
    TEST_DB_PATH: join(root, 'db.sqlite'),
    TEST_ARCHIVE_DIR: join(root, 'archive'),
    TEST_PROJECTS_DIR: join(root, 'projects'),
  });
  const index = spawnSync(process.execPath, [join(repo, 'dist/index-cli.js'), 'index-all', '--no-summaries'], { env: process.env, encoding: 'utf8' });
  if (index.status !== 0) throw new Error(`indexing failed: ${index.stdout}\n${index.stderr}`);
}, 120000);

afterAll(() => {
  for (const k of ISOLATION) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!().catch(() => {});
  delete process.env.EPISODIC_MEMORY_FORCE_EMBEDDINGS_UNAVAILABLE;
});

async function serve(extra: Record<string, string> = {}): Promise<string> {
  Object.assign(process.env, { EPISODIC_MEMORY_HTTP_TOKEN_FILE: tokenFile, EPISODIC_MEMORY_HTTP_PORT: '0', EPISODIC_MEMORY_HTTP_WORKERS: '1', ...extra });
  const service = await startHttp({ workerPath });
  open.push(() => service.close());
  return `http://127.0.0.1:${service.port}/mcp`;
}

type ProbeResult = { status: number | null; report: { ok: boolean; reason?: string; embeddingVersion?: { index: number; build: number } }; stdout: string };

/** Runs the probe as its own process (async, so the in-process service keeps serving). */
function probe(url: string, dbPath = join(root, 'db.sqlite')): Promise<ProbeResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EPISODIC_MEMORY_HTTP_TOKEN_FILE: tokenFile,
    EPISODIC_MEMORY_HTTP_URL: url,
    EPISODIC_MEMORY_PROBE_QUERY: 'zebra widget cache',
    TEST_DB_PATH: dbPath,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probeScript], { cwd: repo, env });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => {
      try {
        resolve({ status, report: JSON.parse(stdout.trim().split('\n').pop() ?? '{}'), stdout });
      } catch (error) {
        reject(new Error(`unparseable probe output: ${stdout}`, { cause: error }));
      }
    });
  });
}

describe('probe-live.mjs', () => {
  it('passes against a healthy service and reports the embedding version', async () => {
    const result = await probe(await serve());
    expect(result.report.ok, result.stdout).toBe(true);
    expect(result.status).toBe(0);
    expect(result.report.embeddingVersion).toEqual({ index: 1, build: 1 });
    expect(result.stdout).not.toContain(token);
  }, 120000);

  it('fails when a default-mode (vector) search errors even though text search works', async () => {
    const result = await probe(await serve({ EPISODIC_MEMORY_FORCE_EMBEDDINGS_UNAVAILABLE: '1' }));
    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.reason).toMatch(/default-mode search/);
  }, 120000);

  it("fails when the index's embedding version differs from the build's", async () => {
    const drifted = join(root, 'drifted.sqlite');
    const require = createRequire(import.meta.url);
    const source = new Database(join(root, 'db.sqlite'), { readonly: true });
    require('sqlite-vec').load(source);
    source.exec(`VACUUM INTO '${drifted}'`);
    source.close();
    const db = new Database(drifted);
    db.prepare('UPDATE exchanges SET embedding_version = 0').run();
    db.close();
    // The version check runs before any network call: no service is needed.
    const result = await probe('http://127.0.0.1:9/mcp', drifted);
    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.reason).toMatch(/embedding version/);
    expect(result.report.embeddingVersion).toEqual({ index: 0, build: 1 });
  }, 120000);
});
