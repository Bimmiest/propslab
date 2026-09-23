// Test fixture: allocates until V8 hits the worker's resourceLimits, so the
// parent sees ERR_WORKER_OUT_OF_MEMORY without depending on how much memory
// any particular engine input happens to need.
const keep = [];
for (;;) keep.push(new Array(100_000).fill(keep.length));
