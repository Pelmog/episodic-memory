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
export async function drainThenExit(options) {
    const { inFlight, drainMs, dispose, exit, log = (line) => console.error(line) } = options;
    if (inFlight.size > 0) {
        const settled = Promise.allSettled([...inFlight]);
        let timer;
        const drained = await Promise.race([
            settled.then(() => true),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), drainMs); }),
        ]);
        clearTimeout(timer);
        if (!drained) {
            log(`Tool worker exit: in-flight call still running after ${drainMs} ms; staying retired until it settles (the pool watchdog restarts the service if it never does)`);
            await settled;
        }
    }
    await dispose();
    await exit();
}
