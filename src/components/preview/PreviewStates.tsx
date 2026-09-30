// ---------------------------------------------------------------------------
// PreviewStates.tsx
// What the output shows in place of a tab: a run that failed, or no run yet.
// ---------------------------------------------------------------------------

import type React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { SAMPLE_CONFIGS } from '../../engine/sampleData';

const SAMPLE_ICONS: Record<string, React.ComponentProps<typeof Icon>['name']> = {
  'Apache Access Log': 'terminal',
  'Palo Alto Firewall': 'shield',
};

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
  const loadInputs = useAppStore((s) => s.loadInputs);
  const manualApply = useAppStore((s) => s.settings.manualApply);

  // loadInputs, not the four setters: it also makes the example the clean
  // baseline, so an unedited example does not count as work to lose.
  const loadExample = (idx: number) => {
    const sample = SAMPLE_CONFIGS[idx];
    if (sample) loadInputs(sample);
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-8 text-center">
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

      <div className="w-full max-w-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-3">
          Or load an example
        </p>
        <div className="grid grid-cols-2 gap-3">
          {SAMPLE_CONFIGS.map((sample, idx) => {
            const iconName = SAMPLE_ICONS[sample.name] ?? 'document';
            return (
              <button
                key={sample.name}
                onClick={() => loadExample(idx)}
                className="group flex flex-col items-start gap-2 p-4 rounded-xl text-left
                  bg-[var(--color-bg-elevated)] border border-[var(--color-border)]
                  hover:border-[var(--color-accent)] hover:shadow-md hover:-translate-y-0.5
                  transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
                  style={{ backgroundColor: 'var(--color-bg-secondary)' }}
                >
                  <Icon
                    name={iconName}
                    className="w-4 h-4 text-[var(--color-accent)] group-hover:text-[var(--color-accent)]"
                  />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-accent)] transition-colors">
                    {sample.name}
                  </p>
                  <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
                    {sample.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
