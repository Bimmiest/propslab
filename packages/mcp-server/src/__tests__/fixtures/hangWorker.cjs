// Test fixture: reports ready, then spins forever without answering, as a run
// stuck in a regex would, so only the parent's watchdog can end it.
const { parentPort } = require('node:worker_threads');
parentPort.postMessage({ kind: 'ready' });
for (;;);
