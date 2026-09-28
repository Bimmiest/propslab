// Test fixture: writes to stdout, as a stray console.log in the engine would,
// then answers. The server's stdout is the JSON-RPC channel, so none of this
// may reach it.
const { parentPort } = require('node:worker_threads');
console.log('stray worker output');
process.stdout.write('more stray output\n', () => {
  parentPort.postMessage({ ok: true, data: 'done' });
});
