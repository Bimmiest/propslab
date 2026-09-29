import { safeRegex } from '../../../../utils/splunkRegex';
import type { RegexMatchInfo } from '../../../../engine/regexMatch';
import type { Matched, RegexMatchState } from '../../../../hooks/useRegexMatch';
import { fieldColorAt } from '../shared/fieldColors';

/**
 * Named capture groups, in group order, as PCRE2 reads the pattern — every
 * spelling (`(?<n>`, `(?P<n>`, `(?'n'`) included. Compiling cannot backtrack,
 * so this is safe on the main thread. None while the pattern does not compile.
 */
export function extractNamedGroups(pattern: string): string[] {
  return pattern ? [...(safeRegex(pattern)?.names ?? [])] : [];
}

/** Assign a color from FIELD_COLORS to each named group */
export function buildGroupColorMap(groups: string[], theme: 'light' | 'dark'): Map<string, string> {
  const map = new Map<string, string>();
  groups.forEach((name, idx) => {
    map.set(name, fieldColorAt(idx, theme));
  });
  return map;
}

export const NO_RESULTS: (RegexMatchInfo | null)[] = [];

/**
 * Settled results aligned to `rawInputs`: `undefined` marks an input whose text
 * the settled run never saw. A match depends only on the pattern and the text,
 * so an input that was in the settled run's inputs already has its answer.
 */
export function alignResults(
  settled: Matched | null,
  rawInputs: string[],
): readonly (RegexMatchInfo | null | undefined)[] {
  if (!settled) return NO_RESULTS;
  if (settled.inputs === rawInputs) return settled.results;
  const byRaw = new Map<string, RegexMatchInfo | null>();
  settled.inputs.forEach((raw, i) => byRaw.set(raw, settled.results[i] ?? null));
  return rawInputs.map((raw) => byRaw.get(raw));
}

/** How many of `results` are matches. */
export function countMatched(results: readonly (RegexMatchInfo | null | undefined)[]): number {
  return results.reduce((n, r) => (r != null ? n + 1 : n), 0);
}

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
export function classNameError(name: string): string | null {
  if (name === '') return 'Enter a class name — EXTRACT- needs one to be a field extraction.';
  if (name.includes('=')) return 'Class name cannot contain "=" — the key would end there.';
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return 'Class name may contain only letters, digits, "_", "-" and ".".';
  }
  return null;
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
export function addBlockReason(
  pattern: string,
  validationError: string | null,
  match: Pick<RegexMatchState, 'pattern' | 'status' | 'inputs'>,
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

/** A run of an event's text and how the highlighted card draws it. */
export type HighlightSegment =
  /** Text before or after the match, muted. */
  | { kind: 'outside'; key: string; text: string }
  /** Match text outside any named group, underlined in green. */
  | { kind: 'between'; key: string; text: string }
  /** A named group's text, in the group's colour. */
  | { kind: 'group'; key: string; text: string; name: string; color: string }
  /** The whole match, when it has no named groups to draw. */
  | { kind: 'whole'; key: string; text: string };

/**
 * The full match's segments: each named group in its colour, and the match text
 * between groups as `between`.
 */
function groupSegments(
  raw: string,
  matchInfo: RegexMatchInfo,
  groupIndices: NonNullable<RegexMatchInfo['groupSpans']>,
  groupColorMap: Map<string, string>,
): HighlightSegment[] {
  const fullMatchStart = matchInfo.index;
  const fullMatchEnd = matchInfo.index + matchInfo.match.length;
  const result: HighlightSegment[] = [];
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
      result.push({ kind: 'between', key: `mid-${cursor}`, text: raw.substring(cursor, gh.start) });
    }
    result.push({ kind: 'group', key: `grp-${gh.name}`, text: raw.substring(gh.start, gh.end), name: gh.name, color: gh.color });
    cursor = gh.end;
  }
  // Remaining match text after last group
  if (cursor < fullMatchEnd) {
    result.push({ kind: 'between', key: `mid-${cursor}`, text: raw.substring(cursor, fullMatchEnd) });
  }
  return result;
}

/** `raw` as segments: the text around the match, and the match itself. */
export function highlightSegments(raw: string, matchInfo: RegexMatchInfo, groupColorMap: Map<string, string>): HighlightSegment[] {
  const fullMatchStart = matchInfo.index;
  const fullMatchEnd = matchInfo.index + matchInfo.match.length;
  const result: HighlightSegment[] = [];

  if (fullMatchStart > 0) {
    result.push({ kind: 'outside', key: 'pre', text: raw.substring(0, fullMatchStart) });
  }

  // Sub-highlights for named groups, from their captured spans.
  const groupIndices = matchInfo.groupSpans;
  if (groupIndices && Object.keys(groupIndices).length > 0) {
    result.push(...groupSegments(raw, matchInfo, groupIndices, groupColorMap));
  } else {
    result.push({ kind: 'whole', key: 'match', text: raw.substring(fullMatchStart, fullMatchEnd) });
  }

  if (fullMatchEnd < raw.length) {
    result.push({ kind: 'outside', key: 'post', text: raw.substring(fullMatchEnd) });
  }

  return result;
}
