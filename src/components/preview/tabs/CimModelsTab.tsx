import { useMemo, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { validateCimCompliance } from '../../../engine/cim/cimModels';
import { ProgressBar } from '../../ui/ProgressBar';
import { Icon } from '../../ui/Icon';

export function CimModelsTab() {
  const result = useAppStore((s) => s.processingResult);
  const [showMatchingOnly, setShowMatchingOnly] = useState(false);

  const allCimResults = useMemo(
    () => validateCimCompliance(new Set(result?.fieldStats.names), { includeAll: true }),
    [result],
  );

  const matchingCount = useMemo(
    () => allCimResults.filter((r) => r.requiredPresent.length > 0 || r.recommendedPresent.length > 0).length,
    [allCimResults],
  );

  const displayResults = showMatchingOnly
    ? allCimResults.filter((r) => r.requiredPresent.length > 0 || r.recommendedPresent.length > 0)
    : allCimResults;

  return (
    <div className="h-full overflow-auto p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--color-text-muted)]">
          {matchingCount > 0
            ? `${matchingCount} matching model${matchingCount !== 1 ? 's' : ''} of ${allCimResults.length}`
            : `${allCimResults.length} models (no fields matched yet)`}
        </span>
        {matchingCount > 0 && (
          // A toggle: the name stays put and aria-pressed carries the state,
          // which the flipping label alone conveyed only to sighted users.
          <button
            type="button"
            aria-pressed={showMatchingOnly}
            onClick={() => setShowMatchingOnly(!showMatchingOnly)}
            className={`text-xs text-[var(--color-accent)] hover:underline cursor-pointer ${showMatchingOnly ? 'font-semibold underline' : ''}`}
          >
            Show matching only
          </button>
        )}
      </div>

      {displayResults.map((cimResult) => (
        <CimModelCard key={cimResult.model.name} result={cimResult} />
      ))}
    </div>
  );
}

function CimModelCard({ result }: { result: ReturnType<typeof validateCimCompliance>[0] }) {
  const [expanded, setExpanded] = useState(false);
  const hasMatches = result.requiredPresent.length > 0 || result.recommendedPresent.length > 0;
  // A few CIM models (Databases, JVM, Interprocess Messaging) declare no key
  // fields at all, so there is no required-field score to show — 100% of an
  // empty list would read as "fully compliant".
  const declaresRequired = result.model.requiredFields.length > 0;

  const variant = result.requiredPercent >= 80 ? 'success' : result.requiredPercent >= 40 ? 'warning' : 'error';

  return (
    <div className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
      >
        <div className="flex-1">
          {/* A model with no matching field is dimmed with the muted token, not
              opacity, which would take the muted description below 4.5:1. */}
          <div
            className={`text-sm font-medium ${hasMatches ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}
          >
            {result.model.displayName}
          </div>
          <div className="text-xs text-[var(--color-text-muted)]">{result.model.description}</div>
        </div>
        <div className="w-32">
          {declaresRequired ? (
            <ProgressBar value={result.requiredPercent} variant={hasMatches ? variant : 'default'} label="Required" />
          ) : (
            <div className="text-xs text-[var(--color-text-muted)]" title="This CIM model declares no required fields">
              Required <span className="font-mono">n/a</span>
            </div>
          )}
        </div>
        <div className="w-32">
          <ProgressBar value={result.totalPercent} variant="default" label="Total" />
        </div>
        <Icon
          name="chevron-down"
          className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="px-3 py-2 border-t border-[var(--color-border)] space-y-2">
          {declaresRequired && (
            <FieldGroup title="Required Fields" present={result.requiredPresent} missing={result.requiredMissing} />
          )}
          <FieldGroup
            title="Recommended Fields"
            present={result.recommendedPresent}
            missing={result.recommendedMissing}
          />
        </div>
      )}
    </div>
  );
}

function FieldGroup({ title, present, missing }: { title: string; present: string[]; missing: string[] }) {
  return (
    <div>
      <div className="text-xs font-medium text-[var(--color-text-muted)] mb-1">{title}</div>
      <div className="flex flex-wrap gap-1">
        {present.map((f) => (
          <span
            key={f}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-[var(--color-success)]/10 text-[var(--color-success)]"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {f}
          </span>
        ))}
        {missing.map((f) => (
          <span
            key={f}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-[var(--color-error)]/10 text-[var(--color-error)]"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}
