// ---------------------------------------------------------------------------
// usePipelineInputs.ts
// The props.conf, transforms.conf and metadata of the run on screen, for the
// views that describe a run rather than the editor: the Timestamp, Effective
// config and Architecture tabs.
// ---------------------------------------------------------------------------

import { selectRunInputs, useAppStore, type PipelineInputs } from '../../../../store/useAppStore';

export type { PipelineInputs };

/**
 * The inputs of the run that produced the events on screen, as the pipeline
 * recorded them beside its answer (#879). Not the editors: in manual-apply
 * mode they can hold config that has not run, and during a run they are ahead
 * of the events. The store holds them, so a component that mounts later (a
 * tab switch, the phone's switch to Output) gets the same answer.
 *
 * Only a new answer changes them, so a keystroke does not re-render a caller.
 */
export function usePipelineInputs(): PipelineInputs {
  return useAppStore(selectRunInputs);
}
