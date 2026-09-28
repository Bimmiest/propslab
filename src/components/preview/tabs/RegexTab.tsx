import { useEffect, useId, useMemo, useState } from 'react';
import { safeRegex, validateRegex } from '../../../utils/splunkRegex';
import { copyToClipboard } from '../../../utils/clipboard';
import { useRegexMatch } from '../../../hooks/useRegexMatch';
import type { RegexMatchInfo } from '../../../engine/regexMatch';
import type { EnrichedEvent } from '../PreviewPanel';
import { fieldColorAt } from './shared/fieldColors';
import { useAppStore } from '../../../store/useAppStore';
import { useApplyDirective } from './shared/useApplyDirective';
import { tint } from '../../../utils/tint';
import { ReferenceTable } from './shared/ReferenceTable';

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

/**
 * Named capture groups, in group order, as PCRE2 reads the pattern — every
 * spelling (`(?<n>`, `(?P<n>`, `(?'n'`) included. Compiling cannot backtrack,
 * so this is safe on the main thread. None while the pattern does not compile.
 */
function extractNamedGroups(pattern: string): string[] {
  return pattern ? [...(safeRegex(pattern)?.names ?? [])] : [];
}

/** Assign a color from FIELD_COLORS to each named group */
function buildGroupColorMap(groups: string[], theme: 'light' | 'dark'): Map<string, string> {
  const map = new Map<string, string>();
  groups.forEach((name, idx) => {
    map.set(name, fieldColorAt(idx, theme));
  });
  return map;
}

const NO_RESULTS: (RegexMatchInfo | null)[] = [];

/**
 * Why `name` cannot be the class in an `EXTRACT-<class>` key, or null if it
 * can. The parser only treats a key as a class directive when something
 * follows the dash, and splits `key = value` at the first `=`, so an empty class
 * would write `EXTRACT- = …` (a bare, unknown key) and `a=b` a key that ends at
 * `a` with `b = …` folded into the value. The editor's highlighter stops a class
 * at whitespace or `=`; beyond that, brackets and the like read as stanza syntax
 * to anyone scanning the file. Kept to the characters Splunk's own class names
 * use, so what the button writes is what every reader of the file parses.
 */
function classNameError(name: string): string | null {
  if (name === '') return 'Enter a class name — EXTRACT- needs one to be a field extraction.';
  if (name.includes('=')) return 'Class name cannot contain "=" — the key would end there.';
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return 'Class name may contain only letters, digits, "_", "-" and ".".';
  }
  return null;
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

type MatchState = ReturnType<typeof useRegexMatch>;

/** One event on the rendered page, with its index in the filtered dataset and its match (if known yet). */
interface PageEntry {
  raw: string;
  datasetIdx: number;
  info: RegexMatchInfo | null | undefined;
}

/**
 * Live matching of `pattern` over the whole filtered dataset, and what the tab
 * can say about it.
 *
 * Run in a terminatable Web Worker. PCRE's limits bound each match, but not
 * the total over thousands of events, so the watchdog still kills a run that
 * takes too long and reports a timeout instead. A pattern with a known
 * validation error is not sent (the tab already shows that error).
 * Matched over the WHOLE filtered dataset, not just the visible page. The
 * header reads "{matched}/{total} events matched" with no scope qualifier, so
 * page-scoped counts said "8/10" while 500 events were loaded — a pattern that
 * failed only on page-2 data read as fully working, which is exactly the false
 * confidence a regex tester exists to prevent. Matching runs in a terminatable
 * worker, so the whole-dataset cost is bounded.
 */
function useRegexResults(
  pattern: string,
  validationError: string | null,
  { items, allEvents, currentPage, eventsPerPage }: RegexTabProps,
) {
  const rawInputs = useMemo(() => allEvents.map((item) => item.event._raw), [allEvents]);
  const requestedPattern = validationError ? '' : pattern;
  const match = useRegexMatch(requestedPattern, rawInputs);
  // Matching runs on a debounced copy of the pattern, so for 250 ms after each
  // keystroke the results still describe the previous one. Reported as 'ok',
  // they put the old pattern's counts, cards and highlights next to an "Add to
  // props.conf" button that writes the new one — a pattern that matched nothing
  // could be committed under the previous pattern's "3/3 events matched".
  // Until the results catch up with what is typed, they are pending.
  //
  // The results are also tied to the inputs they were matched over. When
  // `allEvents` changes — a pipeline re-run, a search keystroke — the new
  // request is posted from an effect, so the results in hand still index the
  // previous array; indexing them by position into the new events would put
  // one event's match on another's card and the old total beside the new one.
  // They are kept on screen while the re-run is in flight rather than flashing
  // the list to pending, and aligned to the new events by text (below).
  const settled = match.settled !== null && match.settled.pattern === requestedPattern ? match.settled : null;
  const status = settled ? 'ok' : match.pattern === requestedPattern ? match.status : 'pending';
  // Settled results for the typed pattern standing in while newer inputs are matched.
  const refreshing = settled !== null && (match.status === 'pending' || settled.inputs !== rawInputs);

  // The settled results, aligned to the events on screen: `undefined` marks an
  // event whose text the settled run never saw. A match depends only on the
  // pattern and the text, so an event that was in the previous inputs already
  // has its answer. A search change resets the shared pagination at once, so
  // the cards follow the new events rather than the previous inputs' page
  // slice: the cards, their numbers and the pagination all describe the same
  // events, and a search refinement, whose events are a subset, is answered in
  // full before the worker replies.
  const aligned = useMemo<readonly (RegexMatchInfo | null | undefined)[]>(() => {
    if (!settled) return NO_RESULTS;
    if (settled.inputs === rawInputs) return settled.results;
    const byRaw = new Map<string, RegexMatchInfo | null>();
    settled.inputs.forEach((raw, i) => byRaw.set(raw, settled.results[i] ?? null));
    return rawInputs.map((raw) => byRaw.get(raw));
  }, [settled, rawInputs]);

  // The rendered page starts at this offset into `rawInputs`.
  const pageOffset = (currentPage - 1) * eventsPerPage;
  const pageEntries = useMemo<PageEntry[]>(() => {
    if (!pattern || validationError || !settled) return [];
    return items.map((item, i) => ({
      raw: item.event._raw,
      datasetIdx: pageOffset + i,
      info: aligned[pageOffset + i],
    }));
  }, [pattern, validationError, settled, items, pageOffset, aligned]);

  // Exact over the events on screen when every one of them has an answer;
  // otherwise the settled run's own count, marked as updating.
  const countExact = settled !== null && aligned.length === rawInputs.length && !aligned.includes(undefined);
  const matchStats = useMemo(() => {
    if (countExact) return { matched: aligned.reduce((n, r) => (r != null ? n + 1 : n), 0), total: rawInputs.length };
    const results = settled?.results ?? NO_RESULTS;
    const matched = results.reduce((n, r) => (r != null ? n + 1 : n), 0);
    return { matched, total: settled ? settled.inputs.length : allEvents.length };
  }, [countExact, aligned, rawInputs, settled, allEvents]);

  return { match, requestedPattern, rawInputs, status, refreshing, pageEntries, countExact, matchStats };
}

/**
 * Why the pattern cannot be added yet, or null when it can.
 *
 * Adding needs a settled 'ok' run of exactly this pattern over exactly these
 * events — the rule the Create EXTRACT dialog applies. Compiling is not
 * enough: a pattern the tab shows as too slow to evaluate (`(a|aa)+b`) would
 * make every pipeline run hit the 5 s watchdog, and inside the debounce window
 * the pattern has not been run at all. A timeout keeps it disabled: the
 * pipeline would hit the same wall.
 */
function addBlockReason(
  pattern: string,
  validationError: string | null,
  match: MatchState,
  requestedPattern: string,
  rawInputs: string[],
): { reason: string | null; isError: boolean } {
  if (!pattern || validationError) return { reason: null, isError: false };
  const current = match.pattern === requestedPattern;
  const isError = current && (match.status === 'timeout' || match.status === 'invalid');
  if (current && match.status === 'timeout') {
    return { reason: 'This pattern timed out — it likely backtracks catastrophically. Simplify the pattern before adding it.', isError };
  }
  if (current && match.status === 'invalid') {
    return { reason: "This pattern won't compile, so it can't be added.", isError };
  }
  if (!current || match.status !== 'ok' || match.inputs !== rawInputs) {
    return { reason: 'Wait for the pattern to finish testing before adding it.', isError };
  }
  return { reason: null, isError: false };
}

/**
 * A confirmation flag that resets itself 1.5 s after it is raised. The reset
 * runs from an effect rather than a bare setTimeout in the click handler, so
 * the timer is cleared if the tab unmounts first (a sub-tab switch within
 * 1.5 s of a click).
 */
function useFlashFlag(): [boolean, () => void] {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!flag) return;
    const t = setTimeout(() => setFlag(false), 1500);
    return () => clearTimeout(t);
  }, [flag]);
  return [flag, () => setFlag(true)];
}

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

function GroupChips({ namedGroups, groupColorMap }: { namedGroups: string[]; groupColorMap: Map<string, string> }) {
  return (
    <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex flex-wrap gap-1.5">
        {namedGroups.map((name) => {
          const color = groupColorMap.get(name) ?? '';
          return (
            <span
              key={name}
              className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: tint(color, 13), color, border: `1px solid ${tint(color, 25)}` }}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              {name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function GroupLegend({ namedGroups, groupColorMap }: { namedGroups: string[]; groupColorMap: Map<string, string> }) {
  return (
    <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-4 text-[10px] flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: '#22c55e40', borderBottom: '2px solid #22c55e' }} />
          <span className="text-[var(--color-text-muted)]">Full match</span>
        </span>
        {namedGroups.map((name) => {
          const color = groupColorMap.get(name) ?? '';
          return (
            <span key={name} className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: tint(color, 25), borderBottom: `2px solid ${color}` }} />
              <span className="text-[var(--color-text-muted)]">{name}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** The EXTRACT directive the pattern makes, with copy and add-to-props.conf. */
function ExtractDirectivePanel({
  pattern, className, setClassName, block, copied: [copied, flashCopied], added: [added, flashAdded],
}: {
  pattern: string;
  className: string;
  setClassName: (value: string) => void;
  block: { reason: string | null; isError: boolean };
  /** The "Copied!" / "Added!" confirmations, owned by the tab so they outlive this panel. */
  copied: [boolean, () => void];
  added: [boolean, () => void];
}) {
  const matchBlockId = useId();
  const classErrorId = useId();
  const { stanza, isPlaceholderStanza, apply: applyDirective } = useApplyDirective();

  const extractDirective = `EXTRACT-${className} = ${pattern}`;
  const matchBlock = block.reason;
  const classError = classNameError(className);
  const canAdd = matchBlock === null && classError === null;
  const addDescribedBy = [matchBlock && matchBlockId, classError && classErrorId].filter(Boolean).join(' ') || undefined;

  /**
   * Write the directive straight into props.conf, closing the loop from
   * experiment to config. The match statistics beside it are whole-dataset,
   * so what is being committed to is visible at the moment of the click
   * rather than inferred from the current page.
   */
  const handleAddToProps = () => {
    if (!canAdd) return;
    applyDirective(`EXTRACT-${className}`, pattern);
    flashAdded();
  };

  // Use the shared helper so copying still works in insecure contexts where
  // navigator.clipboard is unavailable (it falls back to execCommand).
  // Settled rather than voided: a rejected copy must not flip the label to
  // "Copied!", and a floating rejection reaches the console (as CopyButton).
  const handleCopy = () => {
    copyToClipboard(extractDirective).then(flashCopied, () => {});
  };

  return (
    <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-xs text-[var(--color-text-muted)]">EXTRACT-</span>
        <input
          type="text"
          aria-label="EXTRACT class name"
          value={className}
          onChange={(e) => setClassName(e.target.value.replace(/\s/g, '_'))}
          aria-invalid={classError !== null}
          aria-describedby={classError ? classErrorId : undefined}
          className="px-1.5 py-0.5 text-xs font-mono rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] w-32"
          placeholder="classname"
        />
      </div>
      {classError && (
        <div id={classErrorId} className="mb-1 text-[10px] text-[var(--color-error)]">{classError}</div>
      )}
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
          disabled={!canAdd}
          aria-describedby={addDescribedBy}
          className="flex-shrink-0 px-2 py-1 text-xs rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title={matchBlock ?? classError ?? `Upsert into [${stanza}] in props.conf`}
        >
          {added ? 'Added!' : 'Add to props.conf'}
        </button>
      </div>
      {matchBlock && (
        <p
          id={matchBlockId}
          className={`mt-1 text-[10px] ${block.isError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'}`}
        >
          {matchBlock}
        </p>
      )}
      {/*
        Say what the button is about to do to the metadata. Writing
        [my:sourcetype] and silently repointing the event's sourcetype at it
        is the right behaviour but a surprising one to discover after
        the fact.
      */}
      {isPlaceholderStanza && (
        <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
          This event has no sourcetype. Adding writes <code>[{stanza}]</code> and sets the
          event&apos;s sourcetype to match, so the stanza applies.
        </p>
      )}
    </div>
  );
}

const REGEX_COLUMNS = [
  { label: 'Pattern', className: 'pb-1 pr-3 font-medium' },
  { label: 'Description', className: 'pb-1 pr-3 font-medium' },
  { label: 'Example', className: 'pb-1 font-medium' },
];
const regexSearchText = (d: RegexDirective) => [d.pattern, d.description, d.example];

/** Regex Reference (collapsible). */
function RegexReference({ onInsert, onReplace }: { onInsert: (pattern: string) => void; onReplace: (pattern: string) => void }) {
  return (
    <ReferenceTable
      title="Regex Reference"
      searchLabel="Search patterns"
      searchPlaceholder="Search patterns..."
      columns={REGEX_COLUMNS}
      categories={REGEX_REFERENCE}
      searchText={regexSearchText}
      renderCategory={(cat) => <RegexCategoryRows key={cat.name} category={cat} onInsert={onInsert} onReplace={onReplace} />}
    />
  );
}

function CenteredNote({ tone = 'muted', children }: { tone?: 'muted' | 'error'; children: React.ReactNode }) {
  return (
    <div className={`flex items-center justify-center py-12 text-sm ${tone === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'}`}>
      {children}
    </div>
  );
}

/** The event cards, or why there are none to show. */
function RegexResults({ pattern, validationError, status, pageEntries, matchedElsewhere, groupColorMap }: {
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
        <RegexReferenceRow
          key={d.pattern}
          directive={d}
          isReplace={isReplace}
          onPick={() => (isReplace ? onReplace(d.pattern) : onInsert(d.pattern))}
        />
      ))}
    </>
  );
}

function RegexReferenceRow({ directive: d, isReplace, onPick }: { directive: RegexDirective; isReplace: boolean; onPick: () => void }) {
  const descriptionId = useId();
  return (
    // Stays a plain row so the table keeps its row and cell semantics: a
    // pressable <tr> gets role="button", which flattens its cells, and its
    // aria-label would replace the description a screen reader reads. The
    // keyboard path is the button in the
    // first cell, described by the description cell; the row's own click is a
    // larger mouse target for the same action.
    <tr
      className="hover:bg-[var(--color-bg-tertiary)] focus-within:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
      onClick={onPick}
      title={isReplace ? `Use pattern: ${d.pattern}` : `Append: ${d.pattern}`}
    >
      <td className="py-0.5 pr-3">
        <button
          type="button"
          // Stopped here so the row's handler does not run the action twice.
          onClick={(e) => { e.stopPropagation(); onPick(); }}
          aria-label={isReplace ? `Use pattern ${d.pattern}` : `Append ${d.pattern}`}
          aria-describedby={descriptionId}
          className="font-mono px-1 py-0.5 rounded text-[11px] text-left bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] border-none cursor-pointer"
        >
          {d.pattern}
        </button>
      </td>
      <td id={descriptionId} className="py-0.5 pr-3 text-[var(--color-text-secondary)]">{d.description}</td>
      <td className="py-0.5 text-[var(--color-text-muted)] font-mono text-[11px]">{d.example}</td>
    </tr>
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
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)] font-medium">
              Matched{capturedFields.length > 0 && ` \u2013 ${capturedFields.length} group${capturedFields.length !== 1 ? 's' : ''}`}
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

const MATCH_TEXT_STYLE = { backgroundColor: '#22c55e20', borderBottom: '2px solid #22c55e' };

/**
 * The full match's spans: each named group in its colour, and the match text
 * between groups underlined in green.
 */
function groupSpans(
  raw: string,
  matchInfo: RegexMatchInfo,
  groupIndices: NonNullable<RegexMatchInfo['groupSpans']>,
  groupColorMap: Map<string, string>,
): React.ReactNode[] {
  const fullMatchStart = matchInfo.index;
  const fullMatchEnd = matchInfo.index + matchInfo.match.length;
  const result: React.ReactNode[] = [];
  const groupHighlights: { start: number; end: number; name: string; color: string }[] = [];

  for (const [name, range] of Object.entries(groupIndices)) {
    if (!range) continue;
    // A group inside a lookaround can capture text outside the match; only the
    // part within it is drawn here, or it would be drawn again as post text.
    const start = Math.max(range[0], fullMatchStart);
    const end = Math.min(range[1], fullMatchEnd);
    if (end < start || (end === start && range[1] > range[0])) continue;
    const color = groupColorMap.get(name) ?? 'var(--color-text-primary)';
    groupHighlights.push({ start, end, name, color });
  }

  groupHighlights.sort((a, b) => a.start - b.start);

  let cursor = fullMatchStart;
  for (const gh of groupHighlights) {
    if (gh.start < cursor) continue;
    // Non-group text within the match
    if (gh.start > cursor) {
      result.push(
        <span key={`mid-${cursor}`} style={MATCH_TEXT_STYLE} className="rounded-sm">
          {raw.substring(cursor, gh.start)}
        </span>,
      );
    }
    // Group text
    result.push(
      <span
        key={`grp-${gh.name}`}
        style={{ backgroundColor: tint(gh.color, 19), borderBottom: `2px solid ${gh.color}`, color: gh.color }}
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
      <span key={`mid-${cursor}`} style={MATCH_TEXT_STYLE} className="rounded-sm">
        {raw.substring(cursor, fullMatchEnd)}
      </span>,
    );
  }
  return result;
}

/** `raw` as spans: the text around the match muted, the match highlighted. */
function matchSegments(raw: string, matchInfo: RegexMatchInfo, groupColorMap: Map<string, string>): React.ReactNode[] {
  const fullMatchStart = matchInfo.index;
  const fullMatchEnd = matchInfo.index + matchInfo.match.length;
  const result: React.ReactNode[] = [];

  // Text before match
  if (fullMatchStart > 0) {
    result.push(
      <span key="pre" className="text-[var(--color-text-muted)]">
        {raw.substring(0, fullMatchStart)}
      </span>,
    );
  }

  // Build sub-highlights for named groups using their captured spans.
  const groupIndices = matchInfo.groupSpans;
  if (groupIndices && Object.keys(groupIndices).length > 0) {
    result.push(...groupSpans(raw, matchInfo, groupIndices, groupColorMap));
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
      <span key="post" className="text-[var(--color-text-muted)]">
        {raw.substring(fullMatchEnd)}
      </span>,
    );
  }

  return result;
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
    () => (matchInfo ? matchSegments(raw, matchInfo, groupColorMap) : null),
    [raw, matchInfo, groupColorMap],
  );

  if (!segments) {
    return <span className="text-[var(--color-text-secondary)]">{raw}</span>;
  }
  return <>{segments}</>;
}
