// Test fixture: holds its slot for workerData.ms, then answers with when it
// ran, so a test can check how many runs overlapped.
const { parentPort, workerData } = require('node:worker_threads');
const startedAt = Date.now();
setTimeout(() => {
  parentPort.postMessage({ ok: true, data: { startedAt, endedAt: Date.now() } });
}, workerData.ms);
