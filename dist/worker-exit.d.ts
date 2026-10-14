/**
 * Exit sequence of a retired tool worker (src/tool-worker.ts), split out so it
 * can be tested without a worker thread.
 *
 * Disposing the ONNX session under a running embedding fails that call and can
 * crash the process, so dispose + exit happen only after every in-flight call
 * has settled. If that takes longer than `drainMs`, a fixed line is logged and
 * the worker simply stays retired (still counted toward the pool's live cap):
 * it exits if the call ever settles, and otherwise the pool watchdog
 * (2 × deadline) exits the process so launchd restarts it.
 */
export declare function drainThenExit(options: {
    inFlight: ReadonlySet<Promise<unknown>>;
    drainMs: number;
    dispose: () => Promise<void>;
    exit: () => Promise<void> | void;
    log?: (line: string) => void;
}): Promise<void>;
