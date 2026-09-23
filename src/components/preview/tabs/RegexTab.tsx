import { useId, useMemo, useState } from 'react';
import { validateRegex } from '../../../utils/splunkRegex';
import { copyToClipboard } from '../../../utils/clipboard';
import { useRegexMatch } from '../../../hooks/useRegexMatch';
import type { RegexMatchInfo } from '../../../engine/regexMatch';
import type { EnrichedEvent } from '../PreviewPanel';
import { fieldColorAt } from './shared/fieldColors';
import { useApplyDirective } from './shared/useApplyDirective';

// ─── Regex Reference Data ────────────────────────────────────────────────────

interface RegexDirective {
  pattern: string;
  description: string;
  example: string;
}

interface RegexCategory {
  name: string;
  directives: RegexDirective[];
}

const REGEX_REFERENCE: RegexCategory[] = [
  {
    name: 'Character Classes',
    directives: [
      { pattern: '\\d', description: 'Digit (0-9)', example: '\\d+' },
      { pattern: '\\w', description: 'Word character (a-z, A-Z, 0-9, _)', example: '\\w+' },
      { pattern: '\\s', description: 'Whitespace', example: '\\s+' },
      { pattern: '.', description: 'Any character except newline', example: '.*' },
      { pattern: '[...]', description: 'Character set', example: '[a-zA-Z]' },
      { pattern: '[^...]', description: 'Negated character set', example: '[^\\s]+' },
    ],
  },
  {
    name: 'Quantifiers',
    directives: [
      { pattern: '*', description: 'Zero or more', example: '\\d*' },
      { pattern: '+', description: 'One or more', example: '\\w+' },
      { pattern: '?', description: 'Zero or one', example: '\\d?' },
      { pattern: '{n}', description: 'Exactly n times', example: '\\d{4}' },
      { pattern: '{n,m}', description: 'Between n and m times', example: '\\d{1,3}' },
      { pattern: '*?', description: 'Zero or more (non-greedy)', example: '.*?' },
    ],
  },
  {
    name: 'Anchors & Groups',
    directives: [
      { pattern: '^', description: 'Start of string', example: '^ERROR' },
      { pattern: '$', description: 'End of string', example: 'done$' },
      { pattern: '\\b', description: 'Word boundary', example: '\\bhost\\b' },
      { pattern: '(?P<name>...)', description: 'Named capture group (Splunk)', example: '(?P<ip>\\d+\\.\\d+\\.\\d+\\.\\d+)' },
      { pattern: '(?:...)', description: 'Non-capturing group', example: '(?:ERROR|WARN)' },
      { pattern: '|', description: 'Alternation (or)', example: 'ERROR|WARN' },
    ],
  },
  {
    name: 'Common Field Patterns',
    directives: [
      { pattern: '(?P<ip>\\d+\\.\\d+\\.\\d+\\.\\d+)', description: 'IPv4 address', example: '192.168.1.1' },
      { pattern: '(?P<ip>(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4})', description: 'IPv6 address', example: '2001:0db8::1' },
      { pattern: '(?P<mac>(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})', description: 'MAC address', example: '00:1A:2B:3C:4D:5E' },
      { pattern: '(?P<status>\\d{3})', description: 'HTTP status code', example: '200, 404, 500' },
      { pattern: '(?P<method>GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)', description: 'HTTP method', example: 'GET' },
      { pattern: '(?P<url>\\/[^\\s?#]*)', description: 'URL path', example: '/api/v1/users' },
      { pattern: '(?P<email>[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,})', description: 'Email address', example: 'user@example.com' },
      { pattern: '(?P<port>\\d{1,5})', description: 'Port number', example: '8080' },
      { pattern: '(?P<duration>\\d+\\.?\\d*)(?:ms|s)', description: 'Duration with unit', example: '123ms, 1.5s' },
      { pattern: '(?P<bytes>\\d+)', description: 'Byte count', example: '1024' },
      { pattern: '(?P<user>[\\w.@-]+)', description: 'Username', example: 'john.doe' },
      { pattern: '(?P<level>DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)', description: 'Log level', example: 'ERROR' },
      { pattern: '(?P<pid>\\d+)', description: 'Process ID', example: '12345' },
      { pattern: '(?P<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', description: 'UUID', example: '550e8400-e29b-41d4-a716-446655440000' },
    ],
  },
  {
    name: 'Key-Value & Delimited',
    directives: [
      { pattern: '(?P<key>\\w+)=(?P<value>[^\\s,]+)', description: 'key=value pair', example: 'user=admin status=200' },
      { pattern: '(?P<key>\\w+)="(?P<value>[^"]*)"', description: 'key="quoted value"', example: 'msg="login success"' },
      { pattern: '"(?P<field>[^"]*)"', description: 'Double-quoted field', example: '"some value"' },
      { pattern: '\\[(?P<field>[^\\]]+)\\]', description: 'Bracketed field', example: '[category]' },
    ],
  },
  {
    name: 'Full Log Examples',
    directives: [
      { pattern: '(?P<ip>\\S+)\\s+\\S+\\s+(?P<user>\\S+)\\s+\\[(?P<timestamp>[^\\]]+)\\]\\s+"(?P<method>\\w+)\\s+(?P<uri>\\S+)\\s+\\S+"\\s+(?P<status>\\d+)\\s+(?P<bytes>\\d+)', description: 'Apache/NCSA Combined Log', example: '10.0.0.1 - frank [10/Oct/2024:13:55:36] "GET /index.html HTTP/1.1" 200 2326' },
      { pattern: '(?P<timestamp>\\S+\\s+\\S+)\\s+(?P<host>\\S+)\\s+(?P<process>\\w+)\\[(?P<pid>\\d+)\\]:\\s+(?P<message>.+)', description: 'Syslog format', example: 'Oct 11 22:14:15 server sshd[1234]: message' },
      { pattern: '(?P<timestamp>[\\d-]+\\s+[\\d:,]+)\\s+(?P<level>\\w+)\\s+\\[(?P<thread>[^\\]]+)\\]\\s+(?P<class>[\\w.]+)\\s+-\\s+(?P<message>.+)', description: 'Log4j / Java logging', example: '2024-01-15 10:30:45,123 ERROR [main] c.e.App - Something failed' },
      { pattern: '(?P<timestamp>[\\d/]+\\s+[\\d:]+)\\s+(?P<src_ip>\\S+)\\s+(?P<method>\\w+)\\s+(?P<uri>\\S+)\\s+(?P<src_port>\\d+)\\s+\\S+\\s+\\S+\\s+(?P<user_agent>\\S+)\\s+\\S+\\s+(?P<status>\\d+)', description: 'IIS W3C Log', example: '2024-01-15 10:30:45 10.0.0.1 GET /page 443 - Mozilla/5.0 - 200' },
      { pattern: '(?P<action>\\w+)\\s+(?P<src_ip>[\\d.]+):(?P<src_port>\\d+)\\s+->\\s+(?P<dest_ip>[\\d.]+):(?P<dest_port>\\d+)', description: 'Firewall connection log', example: 'ALLOW 10.0.0.1:5432 -> 10.0.0.2:443' },
    ],
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract named capture group names from either Splunk or JS syntax */
function extractNamedGroups(pattern: string): string[] {
  const groups: string[] = [];
  const regex = /\(\?P?<(\w+)>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pattern)) !== null) {
    const name = match[1];
    if (name !== undefined) groups.push(name);
  }
  return groups;
}

/** Assign a color from FIELD_COLORS to each named group */
function buildGroupColorMap(groups: string[]): Map<string, string> {
  const map = new Map<string, string>();
  groups.forEach((name, idx) => {
    map.set(name, fieldColorAt(idx));
  });
  return map;
}

// ─── Main Component ──────────────────────────────────────────────────────────

interface RegexTabProps {
  /** The current page's events — what gets rendered. */
  items: EnrichedEvent[];
  /** The whole filtered dataset — what the match statistics are computed over. */
  allEvents: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
}

export function RegexTab({ items, allEvents, currentPage, eventsPerPage }: RegexTabProps) {
  const patternId = useId();
  const [pattern, setPattern] = useState('');
  const [className, setClassName] = useState('custom');
  const [refOpen, setRefOpen] = useState(false);
  const [refSearch, setRefSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const [added, setAdded] = useState(false);
  const { stanza, isPlaceholderStanza, apply: applyDirective } = useApplyDirective();

  // Compile-only validation (safe on the main thread — compiling can't backtrack).
  // Pass the raw Splunk pattern so validateRegex runs the single canonical
  // Splunk→JS translation internally. Actual matching happens in the worker below.
  const validationError = useMemo(() => {
    if (!pattern) return null;
    return validateRegex(pattern);
  }, [pattern]);

  const namedGroups = useMemo(() => extractNamedGroups(pattern), [pattern]);
  const groupColorMap = useMemo(() => buildGroupColorMap(namedGroups), [namedGroups]);

  const extractDirective = useMemo(() => {
    if (!pattern || validationError) return null;
    return `EXTRACT-${className} = ${pattern}`;
  }, [pattern, className, validationError]);

  const filteredRef = useMemo(() => {
    if (!refSearch) return REGEX_REFERENCE;
    const lower = refSearch.toLowerCase();
    return REGEX_REFERENCE.map((cat) => ({
      ...cat,
      directives: cat.directives.filter(
        (d) =>
          d.pattern.toLowerCase().includes(lower) ||
          d.description.toLowerCase().includes(lower) ||
          d.example.toLowerCase().includes(lower),
      ),
    })).filter((cat) => cat.directives.length > 0);
  }, [refSearch]);

  // Run the live matching in a terminatable Web Worker so a catastrophic pattern
  // that slips the ReDoS heuristic can't freeze this tab — the watchdog kills the
  // worker and reports a timeout instead. A pattern with a known validation error
  // is not sent (we already show that error).
  // Matched over the WHOLE filtered dataset, not just the visible page. The
  // header reads "{matched}/{total} events matched" with no scope qualifier, so
  // page-scoped counts said "8/10" while 500 events were loaded — a pattern that
  // failed only on page-2 data read as fully working, which is exactly the false
  // confidence a regex tester exists to prevent. Matching runs in a terminatable
  // worker, so the whole-dataset cost is bounded.
  const rawInputs = useMemo(() => allEvents.map((item) => item.event._raw), [allEvents]);
  const { status, results } = useRegexMatch(validationError ? '' : pattern, rawInputs);

  // Aligned to `allEvents`; the rendered page starts at this offset into it.
  const pageOffset = (currentPage - 1) * eventsPerPage;
  const matchInfoFor = (datasetIdx: number): RegexMatchInfo | null =>
    status === 'ok' ? results[datasetIdx] ?? null : null;

  /** Page events that matched, each carrying its index in the full dataset. */
  const matchedPageItems = useMemo(() => {
    if (!pattern || validationError || status !== 'ok') return [];
    return items
      .map((item, i) => ({ item, datasetIdx: pageOffset + i }))
      .filter(({ datasetIdx }) => results[datasetIdx] != null);
  }, [pattern, validationError, status, items, results, pageOffset]);

  const matchStats = useMemo(() => {
    const matched = status === 'ok' ? results.reduce((n, r) => (r != null ? n + 1 : n), 0) : 0;
    return { matched, total: allEvents.length };
  }, [status, results, allEvents]);

  /**
   * Write the directive straight into props.conf (#88), closing the loop from
   * experiment to config. The match statistics beside it are whole-dataset
   * (#78), so what is being committed to is visible at the moment of the click
   * rather than inferred from the current page.
   */
  const handleAddToProps = () => {
    if (!pattern || validationError) return;
    applyDirective(`EXTRACT-${className}`, pattern);
    setAdded(true);
    setTimeout(() => setAdded(false), 1500);
  };

  const handleCopy = () => {
    if (extractDirective) {
      // Use the shared helper so copying still works in insecure contexts where
      // navigator.clipboard is unavailable (it falls back to execCommand).
      void copyToClipboard(extractDirective);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Regex input */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-2 mb-1">
          <label htmlFor={patternId} className="text-xs font-medium text-[var(--color-text-muted)]">Regex Pattern</label>
          {pattern && !validationError && matchStats.total > 0 && (
            <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">
              {matchStats.matched}/{matchStats.total} events matched
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
      {namedGroups.length > 0 && !validationError && (
        <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="flex flex-wrap gap-1.5">
            {namedGroups.map((name) => {
              const color = groupColorMap.get(name)!;
              return (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: color + '20', color, border: `1px solid ${color}40` }}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  {name}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* EXTRACT directive output */}
      {pattern && !validationError && (
        <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="flex items-center gap-1 mb-1">
            <span className="text-xs text-[var(--color-text-muted)]">EXTRACT-</span>
            <input
              type="text"
              aria-label="EXTRACT class name"
              value={className}
              onChange={(e) => setClassName(e.target.value.replace(/\s/g, '_'))}
              className="px-1.5 py-0.5 text-xs font-mono rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] w-32"
              placeholder="classname"
            />
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono px-2 py-1.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-success)] break-all select-all">
              {extractDirective}
            </code>
            <button
              onClick={handleCopy}
              className="flex-shrink-0 px-2 py-1 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
              title="Copy to clipboard"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={handleAddToProps}
              className="flex-shrink-0 px-2 py-1 text-xs rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
              title={`Upsert into [${stanza}] in props.conf`}
            >
              {added ? 'Added!' : 'Add to props.conf'}
            </button>
          </div>
          {/*
            Say what the button is about to do to the metadata. Writing
            [my:sourcetype] and silently repointing the event's sourcetype at it
            is the right behaviour (#72) but a surprising one to discover after
            the fact.
          */}
          {isPlaceholderStanza && (
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              This event has no sourcetype. Adding writes <code>[{stanza}]</code> and sets the
              event&apos;s sourcetype to match, so the stanza applies.
            </p>
          )}
        </div>
      )}

      {/* Regex Reference (collapsible) */}
      <div className="flex-shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <button
          onClick={() => setRefOpen(!refOpen)}
          className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer text-left"
        >
          <svg
            className="w-3 h-3 transition-transform flex-shrink-0"
            style={{ color: 'var(--color-text-muted)', transform: refOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-xs font-medium text-[var(--color-text-muted)]">Regex Reference</span>
        </button>
        {refOpen && (
          <div className="px-3 pb-2">
            <div className="relative mb-2">
              <svg
                className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none"
                style={{ color: 'var(--color-text-muted)' }}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                aria-label="Search patterns"
                placeholder="Search patterns..."
                value={refSearch}
                onChange={(e) => setRefSearch(e.target.value)}
                className="w-full max-w-xs pl-6 pr-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <div className="max-h-56 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                    <th className="pb-1 pr-3 font-medium">Pattern</th>
                    <th className="pb-1 pr-3 font-medium">Description</th>
                    <th className="pb-1 font-medium">Example</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRef.map((cat) => (
                    <RegexCategoryRows key={cat.name} category={cat} onInsert={(p) => setPattern((prev) => prev + p)} onReplace={(p) => setPattern(p)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      {pattern && !validationError && namedGroups.length > 0 && (
        <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="flex items-center gap-4 text-[10px] flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: '#22c55e40', borderBottom: '2px solid #22c55e' }} />
              <span className="text-[var(--color-text-muted)]">Full match</span>
            </span>
            {namedGroups.map((name) => {
              const color = groupColorMap.get(name)!;
              return (
                <span key={name} className="flex items-center gap-1.5">
                  <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: color + '40', borderBottom: `2px solid ${color}` }} />
                  <span className="text-[var(--color-text-muted)]">{name}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Event cards */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {validationError ? (
          <div className="flex items-center justify-center py-12 text-[var(--color-error)] text-sm">
            Fix the regex error above to see matches
          </div>
        ) : !pattern ? (
          <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)] text-sm">
            Enter a pattern above to test matches against your events
          </div>
        ) : status === 'timeout' ? (
          <div className="flex flex-col items-center justify-center gap-1 py-12 text-[var(--color-error)] text-sm text-center px-4">
            <span className="font-medium">This pattern is too slow to evaluate and was stopped.</span>
            <span className="text-[var(--color-text-muted)] text-xs">
              It likely triggers catastrophic backtracking (ReDoS). Simplify it — e.g. avoid nested or overlapping quantifiers.
            </span>
          </div>
        ) : status === 'pending' ? (
          <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)] text-sm">
            Testing pattern…
          </div>
        ) : matchedPageItems.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)] text-sm">
            {matchStats.matched > 0
              ? `No events matched on this page — ${matchStats.matched} matched elsewhere in the dataset`
              : 'No events matched'}
          </div>
        ) : (
          matchedPageItems.map(({ item, datasetIdx }) => (
            <RegexEventCard
              key={datasetIdx}
              raw={item.event._raw}
              globalIdx={datasetIdx + 1}
              hasPattern={!!pattern}
              matchInfo={matchInfoFor(datasetIdx)}
              groupColorMap={groupColorMap}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Reference Table ─────────────────────────────────────────────────────────

/** Categories that contain full patterns meant to replace the input rather than append */
const REPLACE_CATEGORIES = new Set(['Common Field Patterns', 'Key-Value & Delimited', 'Full Log Examples']);

function RegexCategoryRows({ category, onInsert, onReplace }: { category: RegexCategory; onInsert: (pattern: string) => void; onReplace: (pattern: string) => void }) {
  const isReplace = REPLACE_CATEGORIES.has(category.name);

  return (
    <>
      <tr>
        <td colSpan={3} className="pt-2 pb-0.5 text-[10px] font-medium text-[var(--color-accent)] uppercase tracking-wider">
          {category.name}
          <span className="ml-1.5 font-normal normal-case tracking-normal text-[var(--color-text-muted)]">
            (click to {isReplace ? 'use' : 'append'})
          </span>
        </td>
      </tr>
      {category.directives.map((d) => (
        <tr
          key={d.pattern}
          className="hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
          onClick={() => isReplace ? onReplace(d.pattern) : onInsert(d.pattern)}
          title={isReplace ? `Use pattern: ${d.pattern}` : `Append: ${d.pattern}`}
        >
          <td className="py-0.5 pr-3">
            <code className="font-mono px-1 py-0.5 rounded text-[11px] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]">
              {d.pattern}
            </code>
          </td>
          <td className="py-0.5 pr-3 text-[var(--color-text-secondary)]">{d.description}</td>
          <td className="py-0.5 text-[var(--color-text-muted)] font-mono text-[11px]">{d.example}</td>
        </tr>
      ))}
    </>
  );
}

// ─── Event Card ──────────────────────────────────────────────────────────────

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
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/20 text-[var(--color-success)] font-medium">
              Matched{capturedFields.length > 0 && ` \u2013 ${capturedFields.length} group${capturedFields.length !== 1 ? 's' : ''}`}
            </span>
          )}
          {hasPattern && !matchInfo && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-error)]/20 text-[var(--color-error)] font-medium">
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
                    <td className="py-0.5 pr-3 font-mono" style={{ color }}>{name}</td>
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

// ─── Highlighted Raw ─────────────────────────────────────────────────────────

function RegexHighlightedRaw({
  raw,
  matchInfo,
  groupColorMap,
}: {
  raw: string;
  matchInfo: RegexMatchInfo | null;
  groupColorMap: Map<string, string>;
}) {
  const segments = useMemo(() => {
    if (!matchInfo) return null;

    const fullMatchStart = matchInfo.index;
    const fullMatchEnd = matchInfo.index + matchInfo.match.length;
    const result: React.ReactNode[] = [];

    // Text before match
    if (fullMatchStart > 0) {
      result.push(
        <span key="pre" className="text-[var(--color-text-primary)] opacity-40">
          {raw.substring(0, fullMatchStart)}
        </span>,
      );
    }

    // Build sub-highlights for named groups using their captured spans.
    const groupIndices = matchInfo.groupSpans;

    if (groupIndices && Object.keys(groupIndices).length > 0) {
      const groupHighlights: { start: number; end: number; name: string; color: string }[] = [];

      for (const [name, range] of Object.entries(groupIndices)) {
        if (!range) continue;
        const color = groupColorMap.get(name) ?? 'var(--color-text-primary)';
        groupHighlights.push({ start: range[0], end: range[1], name, color });
      }

      groupHighlights.sort((a, b) => a.start - b.start);

      let cursor = fullMatchStart;
      for (const gh of groupHighlights) {
        if (gh.start < cursor) continue;
        // Non-group text within the match
        if (gh.start > cursor) {
          result.push(
            <span
              key={`mid-${cursor}`}
              style={{ backgroundColor: '#22c55e20', borderBottom: '2px solid #22c55e' }}
              className="rounded-sm"
            >
              {raw.substring(cursor, gh.start)}
            </span>,
          );
        }
        // Group text
        result.push(
          <span
            key={`grp-${gh.name}`}
            style={{ backgroundColor: gh.color + '30', borderBottom: `2px solid ${gh.color}`, color: gh.color }}
            className="rounded-sm px-0.5"
            title={`${gh.name}: ${raw.substring(gh.start, gh.end)}`}
          >
            {raw.substring(gh.start, gh.end)}
          </span>,
        );
        cursor = gh.end;
      }
      // Remaining match text after last group
      if (cursor < fullMatchEnd) {
        result.push(
          <span
            key={`mid-${cursor}`}
            style={{ backgroundColor: '#22c55e20', borderBottom: '2px solid #22c55e' }}
            className="rounded-sm"
          >
            {raw.substring(cursor, fullMatchEnd)}
          </span>,
        );
      }
    } else {
      // No named groups or no indices -- highlight full match in green
      result.push(
        <span
          key="match"
          style={{ backgroundColor: '#22c55e35', borderBottom: '2px solid #22c55e' }}
          className="rounded-sm px-0.5"
        >
          {raw.substring(fullMatchStart, fullMatchEnd)}
        </span>,
      );
    }

    // Text after match
    if (fullMatchEnd < raw.length) {
      result.push(
        <span key="post" className="text-[var(--color-text-primary)] opacity-40">
          {raw.substring(fullMatchEnd)}
        </span>,
      );
    }

    return result;
  }, [raw, matchInfo, groupColorMap]);

  if (!segments) {
    return <span className="text-[var(--color-text-primary)] opacity-60">{raw}</span>;
  }
  return <>{segments}</>;
}
