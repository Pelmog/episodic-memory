import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolPool, PoolBusyError, type PoolOptions } from '../src/tool-pool.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/workers/blocking-worker.mjs', import.meta.url));
const REAL_WORKER = fileURLToPath(new URL('../dist/tool-worker.js', import.meta.url));

type Pool = ReturnType<typeof createToolPool>;
const pools: Pool[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map((p) => p.close())); });

function pool(overrides: Partial<PoolOptions> = {}): Pool {
  const p = createToolPool({ workerPath: FIXTURE, size: 2, deadlineMs: 10_000, maxQueue: 10, ...overrides });
  pools.push(p);
  return p;
}

const never = () => new AbortController().signal;
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const threadOf = (r: { content: Array<{ text: string }> }) => text(r).split(':')[2];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CANCELLED = { isError: true, content: [{ type: 'text', text: 'Error: Request cancelled' }] };

/** Round-trip every worker once so spawn time never counts against a timed assertion. */
async function warm(p: Pool, size: number): Promise<Set<string>> {
  // Concurrent short blocks occupy every slot at once, so each worker answers one.
  const results = await Promise.all(Array.from({ length: size }, () => p.run('block', { ms: 20 }, never())));
  return new Set(results.map(threadOf));
}

describe('tool pool (fixture worker)', () => {
  it('serves a fast call on another worker while one is blocked', async () => {
    const p = pool();
    await warm(p, 2);
    const slow = p.run('block', { ms: 1500 }, never());
    await sleep(50);
    const t0 = Date.now();
    const fast = await p.run('fast', {}, never());
    expect(Date.now() - t0).toBeLessThan(500);
    expect(text(fast)).toMatch(/^fast:/);
    expect(text(await slow)).toMatch(/^block:/);
  });

  it('enforces the deadline and replaces the stuck worker', async () => {
    const p = pool({ deadlineMs: 300 });
    const before = await warm(p, 2);
    const t0 = Date.now();
    const result = await p.run('block', { ms: 2000 }, never());
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Error: Tool call exceeded the 300 ms deadline' }] });
    // Both slots answer promptly: neither is the worker still spinning in its 2 s block.
    const t1 = Date.now();
    const after = await Promise.all([p.run('block', { ms: 20 }, never()), p.run('block', { ms: 20 }, never())]);
    expect(Date.now() - t1).toBeLessThan(1000);
    for (const r of after) expect(r.isError).toBeFalsy();
    expect(new Set(after.map(threadOf))).not.toEqual(before);
    expect(p.stats()).toMatchObject({ busy: 0, queued: 0, size: 2 });
  });

  it('ignores the late reply of a retired worker', async () => {
    const p = pool({ size: 1, deadlineMs: 1000 });
    const [retired] = await warm(p, 1);
    const t0 = Date.now();
    expect(text(await p.run('block', { ms: 2500 }, never()))).toBe('Error: Tool call exceeded the 1000 ms deadline');
    await sleep(1700 - (Date.now() - t0));
    // The retired worker replies at ~2500 ms, in the middle of this call on its replacement,
    // which must still get its own result.
    const t1 = Date.now();
    const own = await p.run('block', { ms: 900 }, never());
    expect(own.isError).toBeFalsy();
    expect(text(own)).toMatch(/^block:/);
    expect(threadOf(own)).not.toBe(retired);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(880);
    expect(p.stats()).toMatchObject({ busy: 0, queued: 0, size: 1 });
  });

  it('cancels a running call and replaces its worker', async () => {
    const p = pool();
    await warm(p, 2);
    const c = new AbortController();
    const running = p.run('block', { ms: 2000 }, c.signal);
    await sleep(100);
    const t0 = Date.now();
    c.abort();
    expect(await running).toEqual(CANCELLED);
    expect(Date.now() - t0).toBeLessThan(500);
    const t1 = Date.now();
    const after = await Promise.all([p.run('fast', {}, never()), p.run('fast', {}, never())]);
    expect(Date.now() - t1).toBeLessThan(1000);
    for (const r of after) expect(text(r)).toMatch(/^fast:/);
  });

  it('cancels a queued call without running it', async () => {
    const p = pool({ size: 1 });
    await warm(p, 1);
    const first = p.run('block', { ms: 500 }, never());
    const c = new AbortController();
    const queued = p.run('block', { ms: 3000 }, c.signal);
    expect(p.stats()).toEqual({ busy: 1, queued: 1, size: 1, live: 1 });
    await sleep(50);
    c.abort();
    expect(await queued).toEqual(CANCELLED);
    expect(p.stats().queued).toBe(0);
    expect(text(await first)).toMatch(/^block:/);
    // Had the cancelled 3 s block run, this would wait behind it.
    const t0 = Date.now();
    expect(text(await p.run('fast', {}, never()))).toMatch(/^fast:/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('resolves an already-aborted call as cancelled without dispatching', async () => {
    const p = pool({ size: 1 });
    const c = new AbortController();
    c.abort();
    expect(await p.run('block', { ms: 3000 }, c.signal)).toEqual(CANCELLED);
    expect(p.stats()).toEqual({ busy: 0, queued: 0, size: 1, live: 1 });
  });

  it('rejects with PoolBusyError when the queue is full', async () => {
    const p = pool({ size: 1, maxQueue: 1 });
    const a = p.run('block', { ms: 300 }, never());
    const b = p.run('fast', {}, never());
    await expect(p.run('fast', {}, never())).rejects.toBeInstanceOf(PoolBusyError);
    expect(p.stats()).toEqual({ busy: 1, queued: 1, size: 1, live: 1 });
    expect(text(await a)).toMatch(/^block:/);
    expect(text(await b)).toMatch(/^fast:/);
  });

  it('caps live workers (active + retiring) at 2 × size', async () => {
    const p = pool({ size: 1, deadlineMs: 100, maxQueue: 1 });
    await warm(p, 1);
    let maxLive = 0;
    const sample = setInterval(() => { maxLive = Math.max(maxLive, p.stats().live); }, 5);
    try {
      const deadline = { isError: true, content: [{ type: 'text', text: 'Error: Tool call exceeded the 100 ms deadline' }] };
      const t0 = Date.now();
      // Miss 1: worker A retires (spinning until ~1500 ms); replacement B spawns → live 2.
      expect(await p.run('block', { ms: 1500 }, never())).toEqual(deadline);
      expect(p.stats()).toEqual({ busy: 0, queued: 0, size: 1, live: 2 });
      // Miss 2: B retires; at the cap, so no replacement: the slot stays empty.
      expect(await p.run('block', { ms: 1500 }, never())).toEqual(deadline);
      expect(p.stats()).toEqual({ busy: 0, queued: 0, size: 1, live: 2 });
      // A new call queues rather than spawning a third worker; one more is PoolBusyError.
      const queued = p.run('fast', {}, never());
      expect(p.stats()).toEqual({ busy: 0, queued: 1, size: 1, live: 2 });
      await expect(p.run('fast', {}, never())).rejects.toBeInstanceOf(PoolBusyError);
      // It runs once A exits (its 1500 ms block ends) and frees capacity.
      expect(text(await queued)).toMatch(/^fast:/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
      // Miss 3, on the refilled slot; the cap still holds.
      expect(await p.run('block', { ms: 1500 }, never())).toEqual(deadline);
      expect(text(await p.run('fast', {}, never()))).toMatch(/^fast:/);
    } finally {
      clearInterval(sample);
    }
    expect(maxLive).toBe(2);
  });

  it('reports a crashed worker and respawns it', async () => {
    const p = pool({ size: 1 });
    expect(await p.run('crash', {}, never())).toEqual({ isError: true, content: [{ type: 'text', text: 'Error: Tool worker crashed' }] });
    expect(text(await p.run('fast', {}, never()))).toMatch(/^fast:/);
  });

  it('close() settles queued and running calls, waits for workers, and refuses new calls', async () => {
    const p = pool({ size: 1, deadlineMs: 150 });
    await warm(p, 1);
    // Leave a retired worker behind too: close() must stop it as well.
    expect(text(await p.run('block', { ms: 400 }, never()))).toMatch(/deadline/);
    const running = p.run('block', { ms: 300 }, never());
    const queued = p.run('fast', {}, never());
    const t0 = Date.now();
    await p.close();
    // Workers are stopped by message, so close() waits for the running block to end.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    const shutdown = { isError: true, content: [{ type: 'text', text: 'Error: Tool pool is shutting down' }] };
    expect(await running).toEqual(shutdown);
    expect(await queued).toEqual(shutdown);
    expect(await p.run('fast', {}, never())).toEqual(shutdown);
    expect(p.stats()).toEqual({ busy: 0, queued: 0, size: 1, live: 0 });
    await p.close(); // idempotent
  });
});

describe('tool pool (real dist/tool-worker.js)', () => {
  let root: string;
  beforeAll(() => {
    // Workers copy process.env at spawn, so isolate before creating the pool.
    delete process.env.EPISODIC_MEMORY_DB_PATH;
    root = mkdtempSync(join(tmpdir(), 'em-pool-'));
    for (const d of ['archive', 'projects', 'config']) mkdirSync(join(root, d), { recursive: true });
    Object.assign(process.env, {
      TEST_DB_PATH: join(root, 'db.sqlite'),
      TEST_ARCHIVE_DIR: join(root, 'archive'),
      TEST_PROJECTS_DIR: join(root, 'projects'),
      EPISODIC_MEMORY_CONFIG_DIR: join(root, 'config'),
    });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('runs tools in the worker with the shared read policy', async () => {
    const p = pool({ workerPath: REAL_WORKER, size: 1, deadlineMs: 20_000 });
    expect(await p.run('nope', {}, never())).toEqual({ isError: true, content: [{ type: 'text', text: 'Error: Unknown tool: nope' }] });

    const inside = join(root, 'archive', 'c.jsonl');
    writeFileSync(inside, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello from the pool' }, timestamp: '2026-10-13T00:00:00Z' }) + '\n');
    const ok = await p.run('read', { path: inside }, never());
    expect(ok.isError).toBeFalsy();
    expect(text(ok)).toContain('hello from the pool');

    const outside = join(root, 'elsewhere.jsonl');
    writeFileSync(outside, '{}\n');
    expect(await p.run('read', { path: outside }, never())).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Error: Path is outside the conversation archive and transcript directories' }],
    });
  });
});
