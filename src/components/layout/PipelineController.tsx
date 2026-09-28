import { useProcessingPipeline } from '../../hooks/useProcessingPipeline';

/**
 * Runs the pipeline and renders nothing. The hook subscribes to every input
 * (raw data, both confs, metadata, settings), so it lives in a leaf: called
 * from AppShell, each keystroke re-rendered the whole app.
 */
export function PipelineController() {
  useProcessingPipeline();
  return null;
}
