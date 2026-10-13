// Test fixture for test/tool-pool.test.ts: a stand-in for src/tool-worker.ts.
// `block` busy-waits args.ms (simulating a synchronous SQLite query),
// `crash` throws (worker 'error' + 'exit'), anything else replies at once.
// `{ type: 'exit' }` is the pool's stop message (it never calls terminate()).
import { parentPort, threadId } from 'node:worker_threads';

parentPort.on('message', (message) => {
  if (message?.type === 'exit') process.exit(0);
  const { id, name, args } = message;
  if (name === 'crash') throw new Error('fixture crash');
  if (name === 'block') {
    const end = Date.now() + args.ms;
    while (Date.now() < end);
  }
  parentPort.postMessage({ id, result: { content: [{ type: 'text', text: `${name}:${process.pid}:${threadId}` }] } });
});
