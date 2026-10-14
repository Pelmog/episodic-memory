import { describe, expect, it, vi } from 'vitest';
import { drainThenExit } from '../src/worker-exit.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(inFlight: Set<Promise<unknown>>, drainMs = 50) {
  const order: string[] = [];
  const dispose = vi.fn(async () => { order.push('dispose'); });
  const exit = vi.fn(() => { order.push('exit'); });
  const log = vi.fn((line: string) => { order.push(`log:${line}`); });
  const done = drainThenExit({ inFlight, drainMs, dispose, exit, log });
  return { order, dispose, exit, log, done };
}

describe('drainThenExit', () => {
  it('disposes and exits right away with nothing in flight', async () => {
    const h = harness(new Set());
    await h.done;
    expect(h.order).toEqual(['dispose', 'exit']);
  });

  it('waits for an in-flight call, then disposes and exits', async () => {
    let settle!: () => void;
    const call = new Promise<void>((resolve) => { settle = resolve; });
    const h = harness(new Set([call]), 5000);
    await sleep(50);
    expect(h.dispose).not.toHaveBeenCalled();
    settle();
    await h.done;
    expect(h.order).toEqual(['dispose', 'exit']);
  });

  it('never disposes or exits while a call is still running past the drain bound', async () => {
    const never = new Promise<void>(() => {});
    const h = harness(new Set([never]), 50);
    await sleep(400);
    expect(h.dispose).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls[0][0]).toBe('Tool worker exit: in-flight call still running after 50 ms; staying retired until it settles (the pool watchdog restarts the service if it never does)');
  });

  it('disposes and exits only once a late call finally settles', async () => {
    let settle!: () => void;
    const late = new Promise<void>((resolve) => { settle = resolve; });
    const h = harness(new Set([late]), 50);
    await sleep(200);
    expect(h.dispose).not.toHaveBeenCalled();
    settle();
    await h.done;
    expect(h.order).toEqual([expect.stringMatching(/^log:/), 'dispose', 'exit']);
  });
});
