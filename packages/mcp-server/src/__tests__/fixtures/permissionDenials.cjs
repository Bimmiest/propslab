// Run under the launcher's permission flags: tries, from the main thread and
// from a worker it starts, each thing the model is meant to refuse — writing
// a file, starting a process, loading a native addon — and prints
// `{ main: {...}, worker: {...} }`, each attempt "ok" or the error code.
// process.argv[2] is a writable path outside the allowed directory.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const attempt = (fn) => {
  try {
    const result = fn();
    if (result && result.error) return result.error.code ?? String(result.error);
    return 'ok';
  } catch (err) {
    return err.code ?? String(err);
  }
};

const probe = (target) => ({
  write: attempt(() => writeFileSync(target, 'x')),
  spawn: attempt(() => spawnSync(process.execPath, ['-e', '0'])),
  // Nothing is loaded either way: without the model this fails as a missing
  // file, under it as a refusal before the file is looked for.
  addon: attempt(() => process.dlopen({ exports: {} }, `${target}.node`)),
});

if (isMainThread) {
  const target = process.argv[2];
  const worker = new Worker(__filename, { workerData: target });
  worker.once('message', (result) => {
    process.stdout.write(JSON.stringify({ main: probe(target), worker: result }));
  });
} else {
  parentPort.postMessage(probe(workerData));
}
