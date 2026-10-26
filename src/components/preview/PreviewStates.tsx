// ---------------------------------------------------------------------------
// PreviewStates.tsx
// What the output shows in place of a tab: a run that failed, or no run yet.
// ---------------------------------------------------------------------------

import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { SAMPLE_CONFIGS } from '../../engine/sampleData';
import { ExamplesMenu } from '../examples/ExamplesMenu';

export function FailureState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center" role="alert">
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center"
        style={{ backgroundColor: 'var(--color-bg-secondary)' }}
      >
        <Icon name="warning" className="w-7 h-7 text-[var(--color-error)]" />
      </div>
      <div>
        <p className="text-sm font-semibold text-[var(--color-text-primary)]">Processing failed</p>
        <p className="text-xs text-[var(--color-text-muted)] max-w-md mt-1">{message}</p>
      </div>
    </div>
  );
}

export function EmptyState() {
  const manualApply = useAppStore((s) => s.settings.manualApply);

  // `justify-center-safe`: centred while it fits, top-aligned in a short panel,
  // so the top never scrolls out of reach.
  return (
    <div className="flex flex-col items-center justify-center-safe h-full gap-8 px-8 py-8 text-center">
      <div className="flex flex-col items-center gap-3">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ backgroundColor: 'var(--color-bg-secondary)' }}
        >
          <Icon name="eye" className="w-7 h-7 text-[var(--color-text-muted)]" />
        </div>
        <div>
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">No data yet</p>
          <p className="text-xs text-[var(--color-text-muted)] max-w-xs mt-1">
            Paste raw log data on the left, then write a sourcetype stanza in props.conf to simulate the pipeline.
            {manualApply && ' Manual apply is on: press Run (Ctrl+Enter) to process it.'}
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-2">
        <ExamplesMenu prominent />
        <p className="text-xs text-[var(--color-text-muted)]">
          {SAMPLE_CONFIGS.length} examples, from web logs to Windows XML. The Examples button in the header opens the
          same list.
        </p>
      </div>
    </div>
  );
}
