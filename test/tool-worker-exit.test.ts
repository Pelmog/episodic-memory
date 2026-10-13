import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
// @ts-expect-error plain .mjs script without type declarations
import { FIXTURE_DIR } from '../scripts/capture-mcp-baseline.mjs';

const workerPath = fileURLToPath(new URL('../dist/tool-worker.js', import.meta.url));
const indexCli = fileURLToPath(new URL('../dist/index-cli.js', import.meta.url));
const ISOLATION = ['HOME', 'EPISODIC_MEMORY_CONFIG_DIR', 'TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'TEST_PROJECTS_DIR', 'EPISODIC_MEMORY_DB_PATH'];

let root: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ISOLATION) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), 'em-worker-exit-'));
  for (const d of ['home', 'archive', 'config', 'projects/baseline-project']) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(join(FIXTURE_DIR, 'conversation.jsonl'), join(root, 'projects', 'baseline-project', 'session.jsonl'));
  delete process.env.EPISODIC_MEMORY_DB_PATH;
  Object.assign(process.env, {
    HOME: join(root, 'home'),
    EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config'),
    TEST_DB_PATH: join(root, 'db.sqlite'),
    TEST_ARCHIVE_DIR: join(root, 'archive'),
    TEST_PROJECTS_DIR: join(root, 'projects'),
  });
  const index = spawnSync(process.execPath, [indexCli, 'index-all', '--no-summaries'], { env: process.env, encoding: 'utf8' });
  if (index.status !== 0) throw new Error(`indexing failed: ${index.stdout}\n${index.stderr}`);
}, 120000);

afterAll(() => {
  for (const k of ISOLATION) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

type Reply = { id: number; result: { isError?: boolean; content: Array<{ text: string }> } };

describe('tool worker exit', () => {
  it('lets an in-flight vector search finish before disposing the model and exiting', async () => {
    const worker = new Worker(workerPath); // copies process.env at spawn
    const replies: Reply[] = [];
    worker.on('message', (reply: Reply) => replies.push(reply));
    const exited = new Promise<number>((resolve) => worker.once('exit', resolve));
    // The call waits on the model load that warm-up started; the exit arrives meanwhile.
    worker.postMessage({ id: 1, name: 'search', args: { query: 'zebra widget cache', mode: 'vector', response_format: 'json' } });
    worker.postMessage({ type: 'exit' });
    expect(await exited).toBe(0);
    expect(replies.map((r) => r.id)).toEqual([1]);
    expect(replies[0].result.isError, replies[0].result.content[0]?.text).toBeFalsy();
    expect(JSON.parse(replies[0].result.content[0].text).results.length).toBeGreaterThan(0);
  }, 120000);

  it('answers a call that arrives after the exit message with an error instead of running it', async () => {
    const worker = new Worker(workerPath);
    const replies: Reply[] = [];
    worker.on('message', (reply: Reply) => replies.push(reply));
    const exited = new Promise<number>((resolve) => worker.once('exit', resolve));
    worker.postMessage({ type: 'exit' });
    worker.postMessage({ id: 2, name: 'search', args: { query: 'zebra widget cache', mode: 'text' } });
    expect(await exited).toBe(0);
    expect(replies).toEqual([{ id: 2, result: { isError: true, content: [{ type: 'text', text: 'Error: Tool worker is exiting' }] } }]);
  }, 120000);
});
