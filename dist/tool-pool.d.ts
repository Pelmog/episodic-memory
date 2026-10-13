import type { ToolExecutor } from './mcp-factory.js';
/** Thrown (as a rejection) by `run` when every worker is busy and the queue is full. */
export declare class PoolBusyError extends Error {
    constructor(message?: string);
}
export type PoolOptions = {
    workerPath: string;
    size: number;
    deadlineMs: number;
    maxQueue: number;
    /** Called at most once when the watchdog finds the pool wedged (see createToolPool). */
    onWedged?: (reason: string) => void;
};
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
export declare function createToolPool(options: PoolOptions): {
    run: ToolExecutor;
    close(): Promise<void>;
    stats(): {
        busy: number;
        queued: number;
        size: number;
        live: number;
    };
};
