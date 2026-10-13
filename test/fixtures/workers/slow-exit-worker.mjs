// Test fixture for test/http-startup.test.ts: a worker that takes 3 s to honour
// the pool's `{ type: 'exit' }` message, to prove pool shutdown is bounded.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (message) => {
  if (message?.type === 'exit') {
    setTimeout(() => process.exit(0), 3000);
    return;
  }
  parentPort.postMessage({ id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } });
});
