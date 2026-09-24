// ---------------------------------------------------------------------------
// usePipelineInputs.ts
// The props.conf and metadata the pipeline last ran with, for the views that
// describe a run rather than the editor: the Timestamp tab (#316) and the
// Effective config tab (#347).
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useAppStore } from '../../../../store/useAppStore';
import { useDebounce } from '../../../../hooks/useDebounce';
import { PIPELINE_DEBOUNCE_MS } from '../../../../hooks/workerLifecycle';
import type { EventMetadata } from '../../../../engine/types';

export interface PipelineInputs {
  propsConf: string;
  metadata: EventMetadata;
}

/**
 * The props.conf and metadata the events on screen were produced from, as near
 * as the caller can tell.
 *
 * The Timestamp tab used to read the live editor state, so its highlights ran
 * ahead of the `_time` badges beside them: in manual-apply mode they showed a
 * config that had not been run, and in auto mode every keystroke re-probed
 * before the pipeline had caught up (#316). The Effective config tab did the
 * same while its footer said it resolved config the way the preview does
 * (#347). Here the inputs follow the pipeline instead — debounced like its
 * auto-run, or frozen at the last "Run pipeline" click in manual-apply mode,
 * which is the moment the pipeline reads them too.
 *
 * The store does not record what a run used, so a component that mounts while
 * manual-apply changes are pending starts from the editor state. Call it from
 * a component that stays mounted across tab switches where that matters.
 */
export function usePipelineInputs(): PipelineInputs {
  const propsConf = useAppStore((s) => s.propsConf);
  const metadata = useAppStore((s) => s.metadata);
  const manualApply = useAppStore((s) => s.settings.manualApply);
  const manualRunTick = useAppStore((s) => s.manualRunTick);

  const live = useMemo(() => ({ propsConf, metadata }), [propsConf, metadata]);
  const debounced = useDebounce(live, PIPELINE_DEBOUNCE_MS);

  // Adjusted during render rather than in an effect, as React recommends for
  // state derived from props, so the frame after a Run click already probes
  // what was run. In auto mode it tracks the debounced inputs, so turning
  // manual-apply on freezes it at the last auto run.
  const [applied, setApplied] = useState({ tick: manualRunTick, inputs: live });
  const target = !manualApply ? debounced : applied.tick !== manualRunTick ? live : applied.inputs;
  if (applied.tick !== manualRunTick || applied.inputs !== target) {
    setApplied({ tick: manualRunTick, inputs: target });
  }
  return target;
}
