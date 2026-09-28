// Run under the launcher's permission flags, allowed to read this directory:
// reports what the main thread and a worker it starts can each read. Prints
// `{ main: { inside, outside }, worker: { inside, outside } }`, each "ok" or
// the error code.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');

const tryRead = (p) => {
  try {
    readFileSync(p);
    return 'ok';
  } catch (err) {
    return err.code;
  }
};
const probe = (outside) => ({ inside: tryRead(__filename), outside: tryRead(outside) });

if (isMainThread) {
  const outside = process.argv[2];
  const worker = new Worker(__filename, { workerData: outside });
  worker.once('message', (result) => {
    process.stdout.write(JSON.stringify({ main: probe(outside), worker: result }));
  });
} else {
  parentPort.postMessage(probe(workerData));
}
