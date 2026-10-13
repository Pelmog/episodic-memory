/**
 * Worker-thread entry for the shared tool pool (src/tool-pool.ts), bundled to
 * dist/tool-worker.js. Each worker owns its read-only index connection and its
 * own embedding pipeline. Messages: `{ id, name, args }` → `{ id, result }`;
 * `{ type: 'exit' }` → exit the thread (the pool never calls terminate()).
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { parentPort } from 'node:worker_threads';
import { openReadOnlyDatabase } from './db.js';
import { disposeEmbeddings, initEmbeddings } from './embeddings.js';
import { callTool, type ToolResult } from './mcp-tools.js';
import { resolveReadablePath } from './read-policy.js';
import { configureSearchDatabase } from './search.js';

const WARM_UP_TIMEOUT_MS = 60_000;

type PoolMessage = { type: 'exit' } | { type?: undefined; id: number; name: string; args: unknown };

if (!parentPort) throw new Error('tool-worker must run inside a worker thread');
const port = parentPort;

configureSearchDatabase(openReadOnlyDatabase);

port.on('message', async (message: PoolMessage) => {
  if (message.type === 'exit') {
    // Exiting while the ONNX session is still being created crashes the process
    // (SIGSEGV), so let an in-flight model load settle first. A warm-up that has
    // not started yet (test-only delay) is simply cancelled.
    cancelWarmUpDelay();
    await warmUpSettled;
    await disposeEmbeddings();
    // Run native-addon finalizers now, while the addons are still loaded: a GC
    // during isolate teardown can otherwise call into an unloaded addon (SIGSEGV).
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    for (let i = 0; i < 3; i++) {
      gc();
      await new Promise((resolve) => setImmediate(resolve));
    }
    process.exit(0);
  }
  const { id, name, args } = message;
  let result: ToolResult;
  try {
    result = await callTool(name, args, { resolveReadPath: resolveReadablePath });
  } catch (error) {
    result = { isError: true, content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  port.postMessage({ id, result });
});

// Warm the embedding model in the background; never block message handling on it.
// On failure, later vector searches retry through initEmbeddings()'s singleflight.
let warmUpTimer: ReturnType<typeof setTimeout> | undefined;
const warmUpTimeout = new Promise<never>((_, reject) => {
  warmUpTimer = setTimeout(() => reject(new Error(`timed out after ${WARM_UP_TIMEOUT_MS} ms`)), WARM_UP_TIMEOUT_MS);
});
// TEST-ONLY: EPISODIC_MEMORY_TEST_WARM_DELAY_MS delays the warm-up start to prove it never gates serving.
const warmDelayMs = Number(process.env.EPISODIC_MEMORY_TEST_WARM_DELAY_MS) || 0;
let warmDelayTimer: ReturnType<typeof setTimeout> | undefined;
let cancelWarmUpDelay = (): void => {};
const warmUp = async (): Promise<void> => {
  if (warmDelayMs > 0) {
    const cancelled = await new Promise<boolean>((resolve) => {
      warmDelayTimer = setTimeout(() => resolve(false), warmDelayMs);
      cancelWarmUpDelay = () => {
        clearTimeout(warmDelayTimer);
        resolve(true);
      };
    });
    if (cancelled) return;
  }
  await initEmbeddings();
};
const warmUpSettled = Promise.race([warmUp(), warmUpTimeout])
  .catch((error) => {
    console.error(`Tool worker embedding warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
  })
  .finally(() => clearTimeout(warmUpTimer));
