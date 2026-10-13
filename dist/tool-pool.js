import { Worker } from 'node:worker_threads';
/** Thrown (as a rejection) by `run` when every worker is busy and the queue is full. */
export class PoolBusyError extends Error {
    constructor(message = 'Tool pool is busy') {
        super(message);
        this.name = 'PoolBusyError';
    }
}
const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const CANCELLED = 'Error: Request cancelled';
const CRASHED = 'Error: Tool worker crashed';
const SHUTTING_DOWN = 'Error: Tool pool is shutting down';
const EXIT_MESSAGE = { type: 'exit' };
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
 */
export function createToolPool(options) {
    const { workerPath, size, deadlineMs, maxQueue } = options;
    const slots = Array.from({ length: size }, () => ({ worker: null, busy: null, awaitingCapacity: false }));
    const queue = [];
    // Every live worker (a slot's current worker or a retiring one) → resolves on its 'exit'.
    // So live count = live.size = (slots with a worker) + (retiring workers not yet exited).
    const live = new Map();
    const maxLive = 2 * size;
    let nextId = 1;
    let closed = false;
    const canSpawn = () => !closed && live.size < maxLive;
    /** A slot can take a call now: it has a worker, or may spawn one under the cap. */
    const usable = (s) => s.busy === null && (s.worker !== null || canSpawn());
    function onWorkerExit(worker) {
        live.delete(worker);
        // Capacity freed: refill slots that were retired at the cap, then serve the queue.
        for (const slot of slots) {
            if (slot.awaitingCapacity && slot.worker === null && canSpawn())
                spawn(slot);
        }
        dispatch();
    }
    function spawn(slot) {
        const worker = new Worker(workerPath);
        let exited;
        live.set(worker, new Promise((resolve) => { exited = resolve; }));
        slot.awaitingCapacity = false;
        worker.on('message', (reply) => {
            // Replies from a retired worker, or for a call that already settled, are stale.
            if (slot.worker === worker && slot.busy !== null && slot.busy.id === reply?.id)
                finish(slot, reply.result);
        });
        const lost = (error) => {
            if (slot.worker !== worker)
                return; // retired, or 'exit' following an 'error' already handled
            slot.worker = null;
            if (closed)
                return;
            if (error instanceof Error)
                console.error(`Tool worker crashed: ${error.message}`);
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
    function replace(slot) {
        if (closed)
            return;
        if (canSpawn())
            spawn(slot);
        else
            slot.awaitingCapacity = true;
    }
    function retire(slot) {
        slot.worker?.postMessage(EXIT_MESSAGE); // stays in `live` until it exits
        slot.worker = null;
        replace(slot);
    }
    function detach(call) {
        clearTimeout(call.timer);
        call.signal.removeEventListener('abort', call.onAbort);
    }
    function finish(slot, result) {
        const call = slot.busy;
        if (!call)
            return;
        slot.busy = null;
        detach(call);
        call.resolve(result);
        dispatch();
    }
    function start(slot, call) {
        const worker = slot.worker ?? spawn(slot);
        slot.busy = call;
        call.timer = setTimeout(() => {
            if (slot.busy !== call)
                return;
            retire(slot);
            finish(slot, errorResult(`Error: Tool call exceeded the ${deadlineMs} ms deadline`));
        }, deadlineMs);
        try {
            worker.postMessage({ id: call.id, name: call.name, args: call.args });
        }
        catch (error) {
            // e.g. DataCloneError for arguments that cannot cross threads; the worker is untouched.
            finish(slot, errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`));
        }
    }
    function dispatch() {
        while (!closed && queue.length > 0) {
            const slot = slots.find(usable);
            if (!slot)
                return;
            start(slot, queue.shift());
        }
    }
    const run = async (name, args, signal) => {
        if (closed)
            return errorResult(SHUTTING_DOWN);
        if (signal.aborted)
            return errorResult(CANCELLED);
        const idle = slots.find(usable);
        if (!idle && queue.length >= maxQueue)
            throw new PoolBusyError();
        return new Promise((resolve) => {
            const call = {
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
                    if (!slot)
                        return;
                    retire(slot);
                    finish(slot, errorResult(CANCELLED));
                },
            };
            signal.addEventListener('abort', call.onAbort, { once: true });
            if (idle)
                start(idle, call);
            else
                queue.push(call);
        });
    };
    async function close() {
        if (!closed) {
            closed = true;
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
            for (const worker of live.keys())
                worker.postMessage(EXIT_MESSAGE);
        }
        await Promise.all(live.values());
    }
    for (const slot of slots)
        spawn(slot);
    return {
        run,
        close,
        stats: () => ({ busy: slots.filter((s) => s.busy !== null).length, queued: queue.length, size, live: live.size }),
    };
}
