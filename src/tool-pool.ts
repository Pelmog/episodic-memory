import { Worker } from 'node:worker_threads';
import type { ToolExecutor } from './mcp-factory.js';
import type { ToolResult } from './mcp-tools.js';

/** Thrown (as a rejection) by `run` when every worker is busy and the queue is full. */
export class PoolBusyError extends Error {
  constructor(message = 'Tool pool is busy') {
    super(message);
    this.name = 'PoolBusyError';
  }
}

export type PoolOptions = {
  workerPath: string;
  size: number;
  deadlineMs: number;
  maxQueue: number;
  /** Called at most once when the watchdog finds the pool wedged (see createToolPool). */
  onWedged?: (reason: string) => void;
};

type Call = {
  id: number;
  name: string;
  args: unknown;
  signal: AbortSignal;
  resolve: (result: ToolResult) => void;
  onAbort: () => void;
  timer?: ReturnType<typeof setTimeout>;
};
/**
 * `worker === null` has two meanings: after an idle crash the slot respawns
 * lazily on its next call (if the cap allows); with `awaitingCapacity` it was
 * retired at the cap and refills as soon as a retiring worker exits.
 */
type Slot = { worker: Worker | null; busy: Call | null; awaitingCapacity: boolean };
type WorkerReply = { id: number; result: ToolResult };

const errorResult = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });
const CANCELLED = 'Error: Request cancelled';
const CRASHED = 'Error: Tool worker crashed';
const SHUTTING_DOWN = 'Error: Tool pool is shutting down';
const EXIT_MESSAGE = { type: 'exit' } as const;

/**
 * Runs tool calls on a fixed set of worker threads so synchronous SQLite work
 * never blocks the main thread. The main thread only dispatches, enforces the
 * per-call deadline (timed from dispatch), and handles cancellation.
 *
 * A worker whose call is cancelled or overruns is retired: the caller is
 * answered at once, a replacement takes the slot, and the old worker is sent
 * `{ type: 'exit' }` and exits itself once its current synchronous work ends.
 * Never `worker.terminate()`: terminating a worker while onnxruntime-node has
 * async native work in flight (model load or an embedding) aborts the whole
 * process with SIGABRT, whereas the worker's own process.exit() is clean.
 *
 * A retiring worker can stay busy for seconds (a sync SQLite query runs to
 * completion), so live workers (active + retiring) are capped at 2 × size.
 * At the cap a deadline/cancel still answers at once, but the slot stays empty
 * (calls queue, PoolBusyError past maxQueue) until a retiring worker exits.
 *
 * Watchdog: since a worker is never terminated, a worker stuck in native code
 * would hold its capacity forever. If a retiring worker is still alive 2 ×
 * deadlineMs after it was retired, or calls are queued while no slot is usable
 * at the cap for 2 × deadlineMs without any dispatch, the pool logs a fixed
 * line and calls `onWedged` once (the HTTP service exits so launchd restarts it).
 */
export function createToolPool(options: PoolOptions): {
  run: ToolExecutor;
  close(): Promise<void>;
  stats(): { busy: number; queued: number; size: number; live: number };
} {
  const { workerPath, size, deadlineMs, maxQueue, onWedged } = options;
  const slots: Slot[] = Array.from({ length: size }, () => ({ worker: null, busy: null, awaitingCapacity: false }));
  const queue: Call[] = [];
  // Every live worker (a slot's current worker or a retiring one) → resolves on its 'exit'.
  // So live count = live.size = (slots with a worker) + (retiring workers not yet exited).
  const live = new Map<Worker, Promise<void>>();
  const maxLive = 2 * size;
  let nextId = 1;
  let closed = false;
  // Watchdog state: retirement time per retiring worker; start of a no-progress stall at the cap.
  const retiredAt = new Map<Worker, number>();
  const wedgeAfterMs = 2 * deadlineMs;
  let stalledSince: number | undefined;
  let wedged = false;

  const canSpawn = () => !closed && live.size < maxLive;
  /** A slot can take a call now: it has a worker, or may spawn one under the cap. */
  const usable = (s: Slot) => s.busy === null && (s.worker !== null || canSpawn());

  function onWorkerExit(worker: Worker): void {
    live.delete(worker);
    retiredAt.delete(worker);
    // Capacity freed: refill slots that were retired at the cap, then serve the queue.
    for (const slot of slots) {
      if (slot.awaitingCapacity && slot.worker === null && canSpawn()) spawn(slot);
    }
    dispatch();
  }

  function spawn(slot: Slot): Worker {
    const worker = new Worker(workerPath);
    let exited!: () => void;
    live.set(worker, new Promise<void>((resolve) => { exited = resolve; }));
    slot.awaitingCapacity = false;
    worker.on('message', (reply: WorkerReply) => {
      // Replies from a retired worker, or for a call that already settled, are stale.
      if (slot.worker === worker && slot.busy !== null && slot.busy.id === reply?.id) finish(slot, reply.result);
    });
    const lost = (error?: unknown) => {
      if (slot.worker !== worker) return; // retired, or 'exit' following an 'error' already handled
      slot.worker = null;
      if (closed) return;
      if (error instanceof Error) console.error(`Tool worker crashed: ${error.message}`);
      // Respawn now if a call was lost; an idle crash respawns lazily on the next dispatch,
      // so a worker that dies at startup cannot spin in a respawn loop.
      if (slot.busy) {
        replace(slot);
        finish(slot, errorResult(CRASHED));
      }
    };
    worker.on('error', lost);
    worker.on('exit', () => {
      lost(); // first, so dispatch below never picks this slot's dead worker
      onWorkerExit(worker);
      exited();
    });
    slot.worker = worker;
    return worker;
  }

  /** Give an emptied slot a new worker now, or once a retiring worker exits if at the cap. */
  function replace(slot: Slot): void {
    if (closed) return;
    if (canSpawn()) spawn(slot);
    else slot.awaitingCapacity = true;
  }

  function retire(slot: Slot): void {
    if (slot.worker) retiredAt.set(slot.worker, Date.now());
    slot.worker?.postMessage(EXIT_MESSAGE); // stays in `live` until it exits
    slot.worker = null;
    replace(slot);
  }

  function detach(call: Call): void {
    clearTimeout(call.timer);
    call.signal.removeEventListener('abort', call.onAbort);
  }

  function finish(slot: Slot, result: ToolResult): void {
    const call = slot.busy;
    if (!call) return;
    slot.busy = null;
    detach(call);
    call.resolve(result);
    dispatch();
  }

  function start(slot: Slot, call: Call): void {
    const worker = slot.worker ?? spawn(slot);
    stalledSince = undefined; // progress
    slot.busy = call;
    call.timer = setTimeout(() => {
      if (slot.busy !== call) return;
      retire(slot);
      finish(slot, errorResult(`Error: Tool call exceeded the ${deadlineMs} ms deadline`));
    }, deadlineMs);
    try {
      worker.postMessage({ id: call.id, name: call.name, args: call.args });
    } catch (error) {
      // e.g. DataCloneError for arguments that cannot cross threads; the worker is untouched.
      finish(slot, errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  function dispatch(): void {
    while (!closed && queue.length > 0) {
      const slot = slots.find(usable);
      if (!slot) return;
      start(slot, queue.shift()!);
    }
  }

  const run: ToolExecutor = async (name, args, signal) => {
    if (closed) return errorResult(SHUTTING_DOWN);
    if (signal.aborted) return errorResult(CANCELLED);
    const idle = slots.find(usable);
    if (!idle && queue.length >= maxQueue) throw new PoolBusyError();

    return new Promise<ToolResult>((resolve) => {
      const call: Call = {
        id: nextId++,
        name,
        args,
        signal,
        resolve,
        onAbort: () => {
          const queued = queue.indexOf(call);
          if (queued >= 0) {
            queue.splice(queued, 1);
            detach(call);
            resolve(errorResult(CANCELLED));
            return;
          }
          const slot = slots.find((s) => s.busy === call);
          if (!slot) return;
          retire(slot);
          finish(slot, errorResult(CANCELLED));
        },
      };
      signal.addEventListener('abort', call.onAbort, { once: true });
      if (idle) start(idle, call);
      else queue.push(call);
    });
  };

  function wedge(kind: string): void {
    wedged = true;
    clearInterval(watchdog);
    console.error(`episodic-memory tool pool wedged (${kind}); exiting for a restart`);
    onWedged?.(kind);
  }

  function checkWedged(): void {
    if (closed || wedged) return;
    const now = Date.now();
    for (const at of retiredAt.values()) {
      if (now - at > wedgeAfterMs) return wedge('retiring worker did not exit');
    }
    const stalled = queue.length > 0 && live.size >= maxLive && !slots.some(usable);
    if (!stalled) stalledSince = undefined;
    else if (stalledSince === undefined) stalledSince = now;
    else if (now - stalledSince > wedgeAfterMs) wedge('no usable worker at the cap');
  }

  const watchdog = setInterval(checkWedged, Math.max(20, Math.min(1000, Math.floor(deadlineMs / 4))));
  watchdog.unref();

  async function close(): Promise<void> {
    if (!closed) {
      closed = true;
      clearInterval(watchdog);
      const pending = [...queue.splice(0), ...slots.flatMap((s) => (s.busy ? [s.busy] : []))];
      for (const slot of slots) {
        slot.busy = null;
        slot.worker = null;
        slot.awaitingCapacity = false;
      }
      for (const call of pending) {
        detach(call);
        call.resolve(errorResult(SHUTTING_DOWN));
      }
      for (const worker of live.keys()) worker.postMessage(EXIT_MESSAGE);
    }
    await Promise.all(live.values());
  }

  for (const slot of slots) spawn(slot);

  return {
    run,
    close,
    stats: () => ({ busy: slots.filter((s) => s.busy !== null).length, queued: queue.length, size, live: live.size }),
  };
}
