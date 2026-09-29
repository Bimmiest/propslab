import { useId, useMemo } from 'react';
import { validateRegex } from '../../../../utils/splunkRegex';
import { useAppStore } from '../../../../store/useAppStore';
import { addBlockReason, buildGroupColorMap, extractNamedGroups } from './regexLogic';
import { useFlashFlag, useRegexResults, type RegexTabProps } from './useRegexResults';
import { GroupChips, GroupLegend } from './GroupBadges';
import { ExtractDirectivePanel } from './ExtractDirectivePanel';
import { RegexReference } from './RegexReference';
import { RegexResults } from './RegexResults';

export function RegexTab(props: RegexTabProps) {
  const patternId = useId();
  // In the store, so they survive the tab unmounting on a sub-tab switch.
  const pattern = useAppStore((s) => s.regexPattern);
  const setPattern = useAppStore((s) => s.setRegexPattern);
  const className = useAppStore((s) => s.regexClassName);
  const setClassName = useAppStore((s) => s.setRegexClassName);
  const copied = useFlashFlag();
  const added = useFlashFlag();

  // Compile-only validation (safe on the main thread — compiling can't backtrack),
  // on the same PCRE2 the pipeline runs. Matching happens in the worker below.
  const validationError = useMemo(() => {
    if (!pattern) return null;
    return validateRegex(pattern);
  }, [pattern]);

  // From the live pattern, like the directive below: the chips, the legend and
  // the directive all describe what is typed. The cards that use the colour map
  // render only once the match results belong to that same pattern (see
  // `status` below), so a group's colour in a card always agrees with the
  // legend beside it.
  const namedGroups = useMemo(() => extractNamedGroups(pattern), [pattern]);
  const theme = useAppStore((s) => s.theme);
  const groupColorMap = useMemo(() => buildGroupColorMap(namedGroups, theme), [namedGroups, theme]);

  const results = useRegexResults(pattern, validationError, props);
  const { status, refreshing, countExact, matchStats } = results;
  const block = addBlockReason(pattern, validationError, results.match, results.requestedPattern, results.rawInputs);
  const showGroups = namedGroups.length > 0 && !validationError;

  return (
    <div className="flex flex-col h-full">
      {/* Regex input */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-2 mb-1">
          <label htmlFor={patternId} className="text-xs font-medium text-[var(--color-text-muted)]">Regex Pattern</label>
          {/* Only settled counts: while matching is pending, "0/N" would
              describe a pattern that has not been tried yet. */}
          {pattern && !validationError && status === 'ok' && matchStats.total > 0 && (
            <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">
              {matchStats.matched}/{matchStats.total} events matched
              {refreshing && !countExact && ' · updating…'}
            </span>
          )}
        </div>
        <input
          id={patternId}
          type="text"
          aria-label="Regular expression pattern"
          placeholder="(?P<field_name>\d+\.\d+\.\d+\.\d+)..."
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          className="w-full px-2 py-1.5 text-xs font-mono rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
          spellCheck={false}
        />
        {validationError && (
          <div className="mt-1 text-[10px] text-[var(--color-error)]">{validationError}</div>
        )}
      </div>

      {/* Named capture groups */}
      {showGroups && <GroupChips namedGroups={namedGroups} groupColorMap={groupColorMap} />}

      {/* EXTRACT directive output */}
      {pattern && !validationError && (
        <ExtractDirectivePanel
          pattern={pattern}
          className={className}
          setClassName={setClassName}
          block={block}
          copied={copied}
          added={added}
        />
      )}

      <RegexReference onInsert={(p) => setPattern(pattern + p)} onReplace={setPattern} />

      {/* Legend */}
      {pattern && showGroups && <GroupLegend namedGroups={namedGroups} groupColorMap={groupColorMap} />}

      {/* Event cards */}
      <div className="flex-1 overflow-auto p-3 space-y-3" aria-busy={refreshing}>
        <RegexResults
          pattern={pattern}
          validationError={validationError}
          status={status}
          pageEntries={results.pageEntries}
          matchedElsewhere={matchStats.matched}
          groupColorMap={groupColorMap}
        />
      </div>
    </div>
  );
}
