// ---------------------------------------------------------------------------
// answerRun.ts
// A pipeline run that answers, for a test that renders the tabs which describe
// a run without mounting the pipeline itself.
// ---------------------------------------------------------------------------

import { useAppStore } from '../store/useAppStore';

/**
 * Record the editors' config as it is now as the inputs of the run on screen,
 * as `useProcessingPipeline` does when a run answers. The result stays as it
 * is, so a test sets it first when it needs one.
 */
export function answerRun(): void {
  const s = useAppStore.getState();
  s.setProcessingResult(s.processingResult, {
    propsConf: s.propsConf,
    transformsConf: s.transformsConf,
    metadata: s.metadata,
  });
}
