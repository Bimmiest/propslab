import { useMemo } from 'react';
import { deploymentTiers } from './deploymentTiers';
import type { PipelineInputs } from '../preview/tabs/shared/usePipelineInputs';

/**
 * Where each part of the configuration runs. Drawn from the props.conf and
 * transforms.conf the pipeline last ran with (`usePipelineInputs`), like the
 * other output tabs: debounced as the pipeline is, and frozen in manual-apply
 * mode, rather than re-parsed on every keystroke.
 */
export function ArchitecturePanel({ inputs, embedded }: { inputs: PipelineInputs; embedded?: boolean }) {
  const { propsConf, transformsConf } = inputs;
  const { hasIndexTime, hasSearchTime, hasRouting } = useMemo(
    () => deploymentTiers(propsConf, transformsConf),
    [propsConf, transformsConf],
  );
  // Forwarders are involved as soon as anything is parsed or routed before indexing.
  const forwarding = hasIndexTime || hasRouting;

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)]">
      {!embedded && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <svg
            className="w-4 h-4 text-[var(--color-accent)]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
            />
          </svg>
          <span className="text-sm font-medium text-[var(--color-text-primary)]">Architecture</span>
        </div>
      )}
      <div className="flex-1 overflow-auto p-3">
        <div className="flex flex-col items-center gap-2">
          <ComponentBox
            label="Universal Forwarder"
            sublabel="inputs.conf"
            active={forwarding}
            description="Data collection & forwarding"
          />
          <Arrow active={forwarding} />
          <ComponentBox
            label="Heavy Forwarder"
            sublabel="props.conf + transforms.conf"
            active={forwarding}
            description={hasRouting ? 'Parsing, routing & transformation' : 'Parsing & transformation'}
            highlight={hasIndexTime}
          />
          <Arrow active={hasIndexTime} />
          <ComponentBox
            label="Indexer"
            sublabel="props.conf + transforms.conf"
            active={hasIndexTime}
            description="Index-time processing & storage"
            highlight={hasIndexTime}
          />
          <Arrow active={hasSearchTime} />
          <ComponentBox
            label="Search Head"
            sublabel="props.conf"
            active={hasSearchTime}
            description="Search-time field extraction"
            highlight={hasSearchTime}
          />
        </div>

        {!hasIndexTime && !hasSearchTime && (
          <div className="mt-4 text-center text-xs text-[var(--color-text-muted)]">
            Add props.conf / transforms.conf configuration to see deployment recommendations
          </div>
        )}
      </div>
    </div>
  );
}

function ComponentBox({
  label,
  sublabel,
  active,
  description,
  highlight,
}: {
  label: string;
  sublabel: string;
  active: boolean;
  description: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`
        w-full max-w-48 px-3 py-2 rounded border text-center transition-all
        ${
          active
            ? highlight
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 shadow-sm'
              : 'border-[var(--color-border-hover)] bg-[var(--color-bg-secondary)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)]'
        }
      `}
    >
      {/* An inactive box is dimmed with the muted token, not opacity. */}
      <div
        className={`text-xs font-semibold ${active ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}
      >
        {label}
      </div>
      <div className="text-xs text-[var(--color-text-muted)] font-mono">{sublabel}</div>
      {active && <div className="text-xs text-[var(--color-text-secondary)] mt-1">{description}</div>}
    </div>
  );
}

function Arrow({ active }: { active: boolean }) {
  return (
    <div
      className={`flex flex-col items-center ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-border-hover)]'}`}
    >
      <div className="w-0.5 h-3 bg-current" />
      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 16l-6-6h12l-6 6z" />
      </svg>
    </div>
  );
}
