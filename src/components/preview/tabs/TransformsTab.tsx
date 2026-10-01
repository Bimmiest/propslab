import { useMemo, useState } from 'react';
import { DirectiveNoOpList } from './shared/DirectiveNoOpList';
import { useAppStore } from '../../../store/useAppStore';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { tint } from '../../../utils/tint';
import type { StepSummary } from '../../../utils/viewResult';

/** Per-event detail rows rendered at first, and added per "show more". */
const DETAIL_PAGE_SIZE = 100;

export function TransformsTab() {
  const result = useAppStore((s) => s.processingResult);

  // Summarised in the worker, which has every event's full trace; see toViewResult.
  const summary = useMemo(() => {
    const steps = result?.stepSummaries ?? [];
    return {
      indexTime: steps.filter((step) => step.phase === 'index-time'),
      searchTime: steps.filter((step) => step.phase === 'search-time'),
    };
  }, [result]);

  return (
    <div className="h-full overflow-auto p-3 space-y-4">
      {result && (
        <div className="text-xs text-[var(--color-text-muted)] mb-2">
          Pipeline processed {result.eventCount} event{result.eventCount !== 1 ? 's' : ''} through{' '}
          {summary.indexTime.length + summary.searchTime.length} unique steps
        </div>
      )}

      <StepSection title="Index-Time Processing" steps={summary.indexTime} phaseColor="var(--color-warning)" />
      <StepSection title="Search-Time Processing" steps={summary.searchTime} phaseColor="var(--color-accent)" />

      {/*
        The directives that ran and changed nothing. Listed after the steps
        that did fire, because a silent no-op is only confusing once you have
        looked for it above and not found it.
      */}
      {result && <DirectiveNoOpList events={result.events} />}

      {summary.indexTime.length === 0 && summary.searchTime.length === 0 && (
        <div className="text-center text-[var(--color-text-muted)] text-sm py-8">No transforms applied yet</div>
      )}
    </div>
  );
}

const PHASE_HINTS: Record<string, string> = {
  'Index-Time Processing':
    'Runs at ingest time — LINE_BREAKER, timestamps, SEDCMD, TRANSFORMS, INGEST_EVAL. Results are stored in the index.',
  'Search-Time Processing':
    'Runs at query time — EXTRACT, KV_MODE, REPORT, FIELDALIAS, EVAL. Results are computed fresh for each search.',
};

/**
 * Why a step removed a field. FIELDALIAS removes an alias target outright;
 * every other step that reports one rewrote the `_raw` an extraction reads.
 */
function removedFieldHint(processor: string, field: string): string {
  return processor === 'FIELDALIAS'
    ? `The alias's source field has no value, so FIELDALIAS … AS removed "${field}". ASNEW would have kept it.`
    : `This step deleted the text "${field}" is extracted from, so the field no longer extracts at all. The extraction itself is not at fault.`;
}

function StepSection({ title, steps, phaseColor }: { title: string; steps: StepSummary[]; phaseColor: string }) {
  if (steps.length === 0) return null;

  return (
    <div>
      {/* h2: the first heading below the page's h1 (axe heading-order). */}
      <h2
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider mb-2"
        style={{ color: phaseColor }}
      >
        {title} ({steps.length} step{steps.length !== 1 ? 's' : ''})
        <Tooltip content={PHASE_HINTS[title]} side="right">
          <button
            type="button"
            aria-label={`About ${title}`}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors p-0 border-none bg-transparent cursor-default"
          >
            <Icon name="info" className="w-3 h-3" />
          </button>
        </Tooltip>
      </h2>
      <div className="space-y-1">
        {steps.map((step, idx) => (
          <div
            key={idx}
            className="flex items-start gap-3 px-3 py-2.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-border)] transition-colors"
          >
            <div
              className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
              style={{ backgroundColor: tint(phaseColor, 13), color: phaseColor }}
            >
              {idx + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-semibold text-[var(--color-text-primary)]">
                  {step.processor}
                </span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  ({step.eventsAffected}/{step.totalEvents} events)
                </span>
              </div>
              <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">{step.summaryText}</div>
              {step.descriptions.length > 1 && <PerEventDetail descriptions={step.descriptions} />}
              {(step.fieldsAdded.length > 0 || step.fieldsModified.length > 0 || step.fieldsRemoved.length > 0) && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {step.fieldsAdded.map((f) => (
                    <span
                      key={`+${f}`}
                      className="px-1.5 py-0.5 text-xs rounded bg-[var(--color-success)]/10 text-[var(--color-success)]"
                    >
                      +{f}
                    </span>
                  ))}
                  {/* A masked field still extracts — it just carries a destroyed
                      value. Flagging it separately stops "looks empty" from being
                      read as "never extracted", which invites the wrong fix. */}
                  {step.fieldsModified.map((f) => (
                    <Tooltip
                      key={`~${f}`}
                      content={`This step rewrote _raw and changed the value of "${f}". The extraction still works — the value it finds is no longer the original.`}
                    >
                      <span className="px-1.5 py-0.5 text-xs rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)] cursor-default">
                        ~{f}
                      </span>
                    </Tooltip>
                  ))}
                  {step.fieldsRemoved.map((f) => (
                    <Tooltip key={`-${f}`} content={removedFieldHint(step.processor, f)}>
                      <span className="px-1.5 py-0.5 text-xs rounded bg-[var(--color-error)]/10 text-[var(--color-error)] cursor-default">
                        −{f}
                      </span>
                    </Tooltip>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The per-event descriptions of one step. Rendered only while open, and a page
 * at a time: every row of every step in the DOM would make switching to this
 * tab slow on large inputs.
 */
function PerEventDetail({ descriptions }: { descriptions: string[] }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(DETAIL_PAGE_SIZE);
  const remaining = descriptions.length - shown;

  return (
    <details className="mt-1" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="text-[10px] text-[var(--color-text-muted)] cursor-pointer hover:text-[var(--color-text-secondary)] transition-colors select-none">
        Per-event detail ({descriptions.length})
      </summary>
      {open && (
        <>
          <ul className="mt-1 space-y-0.5">
            {descriptions.slice(0, shown).map((d, i) => (
              <li
                key={i}
                className="text-[11px] text-[var(--color-text-muted)] pl-2 border-l border-[var(--color-border-subtle)]"
              >
                {d}
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setShown((n) => n + DETAIL_PAGE_SIZE)}
              className="mt-1 text-[10px] text-[var(--color-accent)] hover:underline cursor-pointer border-none bg-transparent p-0"
            >
              Show {Math.min(remaining, DETAIL_PAGE_SIZE)} more ({remaining} not shown)
            </button>
          )}
        </>
      )}
    </details>
  );
}
