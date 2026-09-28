import { extractionLimits, safeRegex, type SplunkRegex } from '../utils/splunkRegex';

/**
 * Serializable result of matching a pattern against one input. Replaces passing a
 * `RegExpExecArray` around (which can't cross a Web Worker boundary) — it carries
 * exactly what the Regex tab renders: the full-match span plus each named group's
 * value and character range.
 */
export interface RegexMatchInfo {
  /** Start offset of the full match in the input. */
  index: number;
  /** The full matched text (group 0). */
  match: string;
  /** Named capture group values (undefined groups omitted). */
  groups: Record<string, string>;
  /** Named capture group [start, end] ranges, for highlighting (undefined groups omitted). */
  groupSpans: Record<string, [number, number]>;
}

function matchOne(regex: SplunkRegex, raw: string): RegexMatchInfo | null {
  const m = regex.exec(raw);
  if (!m) return null;
  const info: RegexMatchInfo = { index: m.index, match: m[0], groups: {}, groupSpans: {} };
  if (m.groups) {
    for (const [name, value] of Object.entries(m.groups)) {
      if (value !== undefined) info.groups[name] = value;
    }
  }
  if (m.indices.groups) {
    for (const [name, span] of Object.entries(m.indices.groups)) {
      if (span) info.groupSpans[name] = span;
    }
  }
  return info;
}

/**
 * Compile `pattern` (Splunk syntax) and match it — first match only, under
 * Splunk's default MATCH_LIMIT and DEPTH_LIMIT, like an inline EXTRACT —
 * against each input. Returns `null` overall when the pattern does not
 * compile; otherwise a per-input array where each element is the match info,
 * or `null` if that input didn't match.
 *
 * Runs in a Web Worker: the limits bound each match, and the caller's watchdog
 * bounds the total over many inputs.
 */
export function matchInputs(pattern: string, inputs: string[]): (RegexMatchInfo | null)[] | null {
  const regex = safeRegex(pattern, '', extractionLimits());
  if (!regex) return null;
  return inputs.map((raw) => matchOne(regex, raw));
}
