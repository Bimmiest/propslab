// Test fixture: starts, then dies before answering, as a worker killed by a
// crash in native code or a stray process.exit would.
const { parentPort } = require('node:worker_threads');
parentPort.postMessage({ kind: 'ready' });
process.exit(3);
