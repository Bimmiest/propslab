// The pipeline for a run on the main thread, which the browser takes only when
// no worker can start. A module of its own so that the hook can load it on
// demand: a dynamic import of the engine's entry point would put the whole
// pipeline in the startup chunk, because that chunk imports the entry point
// too.
export { runPipeline } from 'propslab-engine';
