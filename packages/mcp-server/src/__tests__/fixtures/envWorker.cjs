// Test fixture: answers with the names of the environment variables it can
// see. A sandbox worker runs agent-supplied patterns and needs none of them.
const { parentPort } = require('node:worker_threads');
parentPort.postMessage({ ok: true, data: Object.keys(process.env) });
