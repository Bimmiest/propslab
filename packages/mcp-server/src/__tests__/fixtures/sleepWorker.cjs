// Test fixture: starts up for workerData.startMs (busy, as evaluating a
// bundle is), reports ready unless workerData.ready is false, then holds its
// slot for workerData.ms and answers with when it ran, so a test can check
// how many runs overlapped.
const { parentPort, workerData } = require('node:worker_threads');
const readyAt = Date.now() + (workerData.startMs ?? 0);
while (Date.now() < readyAt);
if (workerData.ready !== false) parentPort.postMessage({ kind: 'ready' });
const startedAt = Date.now();
setTimeout(() => {
  parentPort.postMessage({ ok: true, data: { startedAt, endedAt: Date.now() } });
}, workerData.ms);
