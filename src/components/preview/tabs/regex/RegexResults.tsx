import { useMemo } from 'react';
import type { RegexMatchInfo } from '../../../../engine/regexMatch';
import { tint } from '../../../../utils/tint';
import { highlightSegments, type HighlightSegment } from './regexLogic';
import type { PageEntry } from './useRegexResults';

function CenteredNote({ tone = 'muted', children }: { tone?: 'muted' | 'error'; children: React.ReactNode }) {
  return (
    <div
      className={`flex items-center justify-center py-12 text-sm ${tone === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'}`}
    >
      {children}
    </div>
  );
}

/** The event cards, or why there are none to show. */
export function RegexResults({
  pattern,
  validationError,
  status,
  pageEntries,
  matchedElsewhere,
  groupColorMap,
}: {
  pattern: string;
  validationError: string | null;
  status: string;
  pageEntries: PageEntry[];
  /** Events matched across the whole dataset. */
  matchedElsewhere: number;
  groupColorMap: Map<string, string>;
}) {
  if (validationError) return <CenteredNote tone="error">Fix the regex error above to see matches</CenteredNote>;
  if (!pattern) return <CenteredNote>Enter a pattern above to test matches against your events</CenteredNote>;
  if (status === 'timeout') {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-12 text-[var(--color-error)] text-sm text-center px-4">
        <span className="font-medium">This pattern is too slow to evaluate and was stopped.</span>
        <span className="text-[var(--color-text-muted)] text-xs">
          It backtracks heavily across many events. Simplify it — e.g. avoid nested or overlapping quantifiers.
        </span>
      </div>
    );
  }
  if (status === 'pending') return <CenteredNote>Testing pattern…</CenteredNote>;

  const matchedPageItems = pageEntries.filter((e) => e.info != null);
  const untestedOnPage = pageEntries.filter((e) => e.info === undefined).length;
  if (matchedPageItems.length === 0) {
    return (
      <CenteredNote>
        {untestedOnPage > 0
          ? 'Testing pattern…'
          : matchedElsewhere > 0
            ? `No events matched on this page — ${matchedElsewhere} matched elsewhere in the dataset`
            : 'No events matched'}
      </CenteredNote>
    );
  }
  return (
    <>
      {matchedPageItems.map(({ raw, datasetIdx, info }) => (
        <RegexEventCard
          key={datasetIdx}
          raw={raw}
          globalIdx={datasetIdx + 1}
          hasPattern={!!pattern}
          matchInfo={info ?? null}
          groupColorMap={groupColorMap}
        />
      ))}
      {untestedOnPage > 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Testing {untestedOnPage} more event{untestedOnPage !== 1 ? 's' : ''} on this page…
        </p>
      )}
    </>
  );
}

function RegexEventCard({
  raw,
  globalIdx,
  hasPattern,
  matchInfo,
  groupColorMap,
}: {
  raw: string;
  globalIdx: number;
  hasPattern: boolean;
  matchInfo: RegexMatchInfo | null;
  groupColorMap: Map<string, string>;
}) {
  const capturedFields = useMemo(
    () => Object.entries(matchInfo?.groups ?? {}).map(([name, value]) => ({ name, value })),
    [matchInfo],
  );

  return (
    <div className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">Event #{globalIdx}</span>
        <div className="flex items-center gap-2">
          {hasPattern && matchInfo && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)] font-medium">
              Matched
              {capturedFields.length > 0 &&
                ` \u2013 ${capturedFields.length} group${capturedFields.length !== 1 ? 's' : ''}`}
            </span>
          )}
          {hasPattern && !matchInfo && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-error)]/10 text-[var(--color-error)] font-medium">
              No match
            </span>
          )}
        </div>
      </div>

      <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all">
        <RegexHighlightedRaw raw={raw} matchInfo={matchInfo} groupColorMap={groupColorMap} />
      </pre>

      {capturedFields.length > 0 && (
        <div className="px-3 pb-2 border-t border-[var(--color-border)]">
          <table className="w-full text-xs mt-1.5">
            <thead>
              <tr className="text-left text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                <th className="pb-1 pr-3 font-medium">Field</th>
                <th className="pb-1 font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {capturedFields.map(({ name, value }) => {
                const color = groupColorMap.get(name) ?? 'var(--color-text-primary)';
                return (
                  <tr key={name}>
                    <td className="py-0.5 pr-3 font-mono" style={{ color }}>
                      {name}
                    </td>
                    <td className="py-0.5 font-mono text-[var(--color-text-primary)]">{value}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const MATCH_TEXT_STYLE = { backgroundColor: '#22c55e20', borderBottom: '2px solid #22c55e' };

function SegmentSpan({ segment }: { segment: HighlightSegment }) {
  switch (segment.kind) {
    case 'outside':
      return <span className="text-[var(--color-text-muted)]">{segment.text}</span>;
    case 'between':
      return (
        <span style={MATCH_TEXT_STYLE} className="rounded-sm">
          {segment.text}
        </span>
      );
    case 'group':
      return (
        <span
          style={{
            backgroundColor: tint(segment.color, 19),
            borderBottom: `2px solid ${segment.color}`,
            color: segment.color,
          }}
          className="rounded-sm px-0.5"
          title={`${segment.name}: ${segment.text}`}
        >
          {segment.text}
        </span>
      );
    case 'whole':
      return (
        <span style={{ backgroundColor: '#22c55e35', borderBottom: '2px solid #22c55e' }} className="rounded-sm px-0.5">
          {segment.text}
        </span>
      );
  }
}

function RegexHighlightedRaw({
  raw,
  matchInfo,
  groupColorMap,
}: {
  raw: string;
  matchInfo: RegexMatchInfo | null;
  groupColorMap: Map<string, string>;
}) {
  const segments = useMemo(
    () => (matchInfo ? highlightSegments(raw, matchInfo, groupColorMap) : null),
    [raw, matchInfo, groupColorMap],
  );

  if (!segments) {
    return <span className="text-[var(--color-text-secondary)]">{raw}</span>;
  }
  return (
    <>
      {segments.map((segment) => (
        <SegmentSpan key={segment.key} segment={segment} />
      ))}
    </>
  );
}
