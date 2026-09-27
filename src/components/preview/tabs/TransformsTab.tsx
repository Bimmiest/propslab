import { useMemo, useState } from 'react';
import { DirectiveNoOpList } from './shared/DirectiveNoOpList';
import { useAppStore } from '../../../store/useAppStore';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';

interface StepSummary {
  processor: string;
  phase: 'index-time' | 'search-time';
  /** Distinct per-event descriptions, in first-seen order. */
  descriptions: string[];
  /** The one line shown for the step. */
  summaryText: string;
  eventsAffected: number;
  totalEvents: number;
  fieldsAdded: string[];
  /** Fields this step left extractable but devalued (e.g. a mask rule). */
  fieldsModified: string[];
  /** Fields this step made unextractable by deleting the text they anchor on. */
  fieldsRemoved: string[];
}

// Strip a trailing "(…)" detail (e.g. "(lines 1-1)") so per-event variants of an
// index-time step collapse to one representative summary line.
const stripDetail = (d: string) => d.replace(/\s*\([^)]*\)\s*$/, '');

/** Per-event detail rows rendered at first, and added per "show more". */
const DETAIL_PAGE_SIZE = 100;

export function TransformsTab() {
  const result = useAppStore((s) => s.processingResult);

  const summary = useMemo(() => {
    if (!result) return { indexTime: [] as StepSummary[], searchTime: [] as StepSummary[] };

    const totalEvents = result.events.length;
    // Group by processor (not processor+description) so index-time steps with
    // per-event descriptions collapse into one row per processor, consistent with
    // the search-time section. Distinct event count and per-event detail are kept.
    // Sets (which keep first-seen order), not Array.includes: a step with a
    // distinct description per event made this quadratic, over a second at
    // 20k events (#366).
    interface Accumulator {
      processor: string;
      phase: StepSummary['phase'];
      descriptions: Set<string>;
      fieldsAdded: Set<string>;
      fieldsModified: Set<string>;
      fieldsRemoved: Set<string>;
      events: Set<number>;
    }
    const stepMap = new Map<string, Accumulator>();

    result.events.forEach((event, eventIdx) => {
      for (const step of event.processingTrace) {
        let entry = stepMap.get(step.processor);
        if (!entry) {
          entry = {
            processor: step.processor,
            phase: step.phase,
            descriptions: new Set(),
            fieldsAdded: new Set(),
            fieldsModified: new Set(),
            fieldsRemoved: new Set(),
            events: new Set<number>(),
          };
          stepMap.set(step.processor, entry);
        }
        entry.events.add(eventIdx);
        entry.descriptions.add(step.description);
        for (const f of step.fieldsAdded ?? []) entry.fieldsAdded.add(f);
        for (const f of step.fieldsModified ?? []) entry.fieldsModified.add(f);
        for (const f of step.fieldsRemoved ?? []) entry.fieldsRemoved.add(f);
      }
    });

    const indexTime: StepSummary[] = [];
    const searchTime: StepSummary[] = [];
    for (const entry of stepMap.values()) {
      const descriptions = [...entry.descriptions];
      const reps = new Set(descriptions.map(stripDetail));
      const step: StepSummary = {
        processor: entry.processor,
        phase: entry.phase,
        descriptions,
        summaryText: reps.size === 1 ? reps.values().next().value! : descriptions[0]!,
        eventsAffected: entry.events.size,
        totalEvents,
        fieldsAdded: [...entry.fieldsAdded],
        fieldsModified: [...entry.fieldsModified],
        fieldsRemoved: [...entry.fieldsRemoved],
      };
      if (step.phase === 'index-time') indexTime.push(step);
      else searchTime.push(step);
    }

    return { indexTime, searchTime };
  }, [result]);

  return (
    <div className="h-full overflow-auto p-3 space-y-4">
      {result && (
        <div className="text-xs text-[var(--color-text-muted)] mb-2">
          Pipeline processed {result.eventCount} event{result.eventCount !== 1 ? 's' : ''} through {summary.indexTime.length + summary.searchTime.length} unique steps
        </div>
      )}

      <StepSection title="Index-Time Processing" steps={summary.indexTime} phaseColor="var(--color-warning)" />
      <StepSection title="Search-Time Processing" steps={summary.searchTime} phaseColor="var(--color-accent)" />

      {/*
        The directives that ran and changed nothing (#84). Listed after the steps
        that did fire, because a silent no-op is only confusing once you have
        looked for it above and not found it.
      */}
      {result && <DirectiveNoOpList events={result.events} />}

      {summary.indexTime.length === 0 && summary.searchTime.length === 0 && (
        <div className="text-center text-[var(--color-text-muted)] text-sm py-8">
          No transforms applied yet
        </div>
      )}
    </div>
  );
}

const PHASE_HINTS: Record<string, string> = {
  'Index-Time Processing': 'Runs at ingest time — LINE_BREAKER, timestamps, SEDCMD, TRANSFORMS, INGEST_EVAL. Results are stored in the index.',
  'Search-Time Processing': 'Runs at query time — EXTRACT, KV_MODE, REPORT, FIELDALIAS, EVAL. Results are computed fresh for each search.',
};

function StepSection({ title, steps, phaseColor }: { title: string; steps: StepSummary[]; phaseColor: string }) {
  if (steps.length === 0) return null;

  return (
    <div>
      {/* h2: the first heading below the page's h1 (axe heading-order). */}
      <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: phaseColor }}>
        {title} ({steps.length} step{steps.length !== 1 ? 's' : ''})
        <Tooltip content={PHASE_HINTS[title]} side="right">
          <button type="button" aria-label={`About ${title}`} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors p-0 border-none bg-transparent cursor-default">
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
            <div className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style={{ backgroundColor: phaseColor + '20', color: phaseColor }}>
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
              <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                {step.summaryText}
              </div>
              {step.descriptions.length > 1 && <PerEventDetail descriptions={step.descriptions} />}
              {(step.fieldsAdded.length > 0 || step.fieldsModified.length > 0 || step.fieldsRemoved.length > 0) && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {step.fieldsAdded.map((f) => (
                    <span key={`+${f}`} className="px-1.5 py-0.5 text-xs rounded bg-[var(--color-success)]/10 text-[var(--color-success)]">
                      +{f}
                    </span>
                  ))}
                  {/* A masked field still extracts — it just carries a destroyed
                      value. Flagging it separately stops "looks empty" from being
                      read as "never extracted", which invites the wrong fix. */}
                  {step.fieldsModified.map((f) => (
                    <Tooltip key={`~${f}`} content={`This step rewrote _raw and changed the value of "${f}". The extraction still works — the value it finds is no longer the original.`}>
                      <span className="px-1.5 py-0.5 text-xs rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)] cursor-default">
                        ~{f}
                      </span>
                    </Tooltip>
                  ))}
                  {step.fieldsRemoved.map((f) => (
                    <Tooltip key={`-${f}`} content={`This step deleted the text "${f}" is extracted from, so the field no longer extracts at all. The extraction itself is not at fault.`}>
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
 * at a time: every row of every step used to be in the DOM, closed or not,
 * which is most of what made switching to this tab slow on large inputs (#366).
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
              <li key={i} className="text-[11px] text-[var(--color-text-muted)] pl-2 border-l border-[var(--color-border-subtle)]">
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
