// Run under the launcher's permission flags: reports whether the main thread
// and a worker it starts can build code from a string. Prints
// `{ main, worker }`, each "ok" or the error's name.
const { Worker, isMainThread, parentPort } = require('node:worker_threads');

const probe = () => {
  try {
    return new Function('return 1')() === 1 ? 'ok' : 'wrong';
  } catch (err) {
    return err.name;
  }
};

if (isMainThread) {
  const worker = new Worker(__filename);
  worker.once('message', (result) => {
    process.stdout.write(JSON.stringify({ main: probe(), worker: result }));
  });
} else {
  parentPort.postMessage(probe());
}
