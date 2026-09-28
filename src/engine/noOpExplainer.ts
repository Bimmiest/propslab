// ---------------------------------------------------------------------------
// noOpExplainer.ts
// Why a directive did nothing to this event.
//
// The dominant failure mode when authoring props/transforms is a directive that
// silently does nothing: the preview renders an unchanged event and there is
// nothing to read. The engine already traces the directives that DO fire, so
// what is missing is the negative case — and the negative case is where the
// debugging time goes.
//
// The order below is the order a person would check by hand, and it matters:
// answering "the regex did not match" for a directive whose stanza never
// matched this event sends them to rewrite a working pattern.
// ---------------------------------------------------------------------------

import { extractionLimits, safeProbeRegex, safeRegex, validateRegex, type RegexLimits } from '../utils/splunkRegex';

const PROBE_LIMITS = extractionLimits();

export type NoOpReason =
  /** The stanza holding this directive did not match the event's metadata. */
  | { kind: 'stanza-not-matched'; stanza: string; wonInstead?: string }
  /** A TRANSFORMS/REPORT reference to a transforms.conf stanza that is not there. */
  | { kind: 'transforms-stanza-missing'; name: string }
  /** The pattern did not compile. */
  | { kind: 'regex-invalid'; error: string }
  /**
   * PCRE gave up before deciding: MATCH_LIMIT or DEPTH_LIMIT (or the backtracking
   * memory cap) was reached. Splunk counts that as no match.
   */
  | { kind: 'regex-limit'; error: string }
  /** SOURCE_KEY (or an `in <field>` source) resolved to nothing. */
  | { kind: 'source-key-empty'; sourceKey: string }
  /**
   * The regex compiled and the source had content, but nothing matched.
   * `partialEnd` is how far into the source the longest matching prefix of the
   * pattern reached — the character the pattern stopped agreeing with.
   */
  | { kind: 'no-match'; partialEnd?: number; partialPattern?: string }
  /** It matched, but every field it produces was already set by an earlier rule. */
  | { kind: 'fields-already-set'; fields: string[] }
  /**
   * It matched, but every value it captured was empty once leading and
   * trailing whitespace was trimmed, and an empty value creates no field.
   */
  | { kind: 'values-empty'; fields: string[] }
  /**
   * An EVAL expression computed null, which deletes the field rather than
   * setting it — so a directive meant to create a field leaves nothing behind.
   * Null propagation makes this the commonest silent EVAL no-op.
   */
  | { kind: 'eval-null'; expression: string }
  /**
   * The pattern did not match, and this directive had already been analysed
   * for as many missed events as a run allows (`RunLimits.explanationsPerDirective`).
   * Not the same as a bare `no-match`, which says the analysis ran and found
   * no partial agreement.
   */
  | { kind: 'not-explained' };

/** One-line rendering, used by the trace and the UI alike. */
export function describeNoOp(reason: NoOpReason): string {
  switch (reason.kind) {
    case 'stanza-not-matched':
      return reason.wonInstead !== undefined
        ? `[${reason.stanza}] did not match this event — [${reason.wonInstead}] won instead`
        : `[${reason.stanza}] did not match this event's metadata`;
    case 'transforms-stanza-missing':
      return `references [${reason.name}], which is not defined in transforms.conf`;
    case 'regex-invalid':
      return `the pattern did not compile: ${reason.error}`;
    case 'regex-limit':
      return `PCRE stopped before finding a match (${reason.error}), which counts as no match — simplify the pattern or raise MATCH_LIMIT / DEPTH_LIMIT`;
    case 'source-key-empty':
      return `${reason.sourceKey} is empty on this event, so there was nothing to match against`;
    case 'no-match':
      return reason.partialEnd !== undefined
        ? `the pattern did not match; it stopped agreeing at character ${reason.partialEnd}`
        : 'the pattern did not match anywhere in the source';
    case 'fields-already-set':
      return `it matched, but ${reason.fields.join(', ')} ${reason.fields.length === 1 ? 'was' : 'were'} already set by an earlier rule`;
    case 'values-empty':
      return `it matched, but ${reason.fields.join(', ')} captured only whitespace, and an empty value creates no field`;
    case 'eval-null':
      return `\`${reason.expression}\` evaluated to null, so no field was written — usually a field referenced in it is absent`;
    case 'not-explained':
      return 'Not analysed: explanation limit reached for this directive';
  }
}

/**
 * What identifies a directive's no-ops across events: its file, line and name.
 * The explanation cap counts by it, and groupNoOps collapses by it.
 */
export function noOpDirectiveKey(noOp: { file: string; line: number; directive: string }): string {
  return `${noOp.file}:${noOp.line}:${noOp.directive}`;
}

/**
 * The reason for a pattern that compiled, had a source, and did not match:
 * how far it got, or `not-explained` when `explain` is false because the
 * directive has used up its explanations for the run.
 */
export function explainNoMatch(pattern: string, source: string, explain: boolean): NoOpReason {
  if (!explain) return { kind: 'not-explained' };
  const partial = longestPartialMatch(pattern, source);
  return partial
    ? { kind: 'no-match', partialEnd: partial.end, partialPattern: partial.prefix }
    : { kind: 'no-match' };
}

/**
 * Cut points at which a pattern can be truncated and still be a valid pattern:
 * the end of each complete top-level atom, including any quantifier attached to
 * it. Cutting anywhere else produces garbage — `(?<user>\w` is not a shorter
 * version of `(?<user>\w+)@`, it is a syntax error — which is why this walks the
 * pattern rather than slicing it by character count.
 *
 * A pattern with a top-level `|` has none: a prefix ending after it (`ERROR|`)
 * matches the empty string anywhere, and one before it describes only the
 * first alternative, not how far the pattern got.
 */
function atomBoundaries(pattern: string): number[] {
  const boundaries: number[] = [];
  let i = 0;
  let groupDepth = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '\\') {
      i += 2;
    } else if (c === '[') {
      i++;
      while (i < pattern.length && pattern[i] !== ']') {
        i += pattern[i] === '\\' ? 2 : 1;
      }
      i++;
    } else if (c === '(') {
      groupDepth++;
      i++;
      continue;
    } else if (c === ')') {
      groupDepth--;
      i++;
    } else if (c === '|' && groupDepth === 0) {
      return [];
    } else {
      i++;
    }

    // Absorb a quantifier so the boundary sits after it, not between the atom
    // and the `+` that governs it.
    while (i < pattern.length && /[*+?]/.test(pattern[i] ?? '')) i++;
    if (pattern[i] === '{') {
      const close = pattern.indexOf('}', i);
      if (close !== -1) i = close + 1;
    }
    if (pattern[i] === '?') i++; // lazy modifier

    if (groupDepth === 0) boundaries.push(i);
  }

  return boundaries;
}

/**
 * How far a non-matching pattern got before it stopped agreeing with the text.
 *
 * Truncates the pattern at successively earlier atom boundaries until one of
 * them matches, and reports where that match ended. "Your regex is fine up to
 * the `@`, and the text has a space there" is the single most useful thing to
 * say about a pattern that does not match.
 *
 * Returns null when even the first atom fails — there is no partial agreement
 * to report, and inventing an offset of 0 would read as a real finding.
 *
 * This runs for every event a directive misses, so it binary-searches the cut
 * points instead of trying each: a prefix of a pattern that matches somewhere
 * also matches there, so "this prefix matches" holds up to some cut and not
 * after it. Trying every cut cost one probe per atom per event, which at a few
 * thousand events was most of the run (#415).
 */
export function longestPartialMatch(
  pattern: string,
  text: string,
): { end: number; prefix: string } | null {
  // The last boundary is the whole pattern, which by the time this is called
  // is already known not to match.
  const cuts = atomBoundaries(pattern)
    .slice(0, -1)
    .filter((cut) => cut > 0);

  const probe = (i: number): { end: number; prefix: string; empty: boolean } | null => {
    const prefix = pattern.slice(0, cuts[i]);
    // Splunk's extraction limits bound each probe, so explaining a no-op can
    // never cost more than one extraction attempt per prefix. The probes go to
    // a cache of their own so they never evict the patterns the pipeline runs.
    const match = safeProbeRegex(prefix, PROBE_LIMITS)?.exec(text);
    return match ? { end: match.index + match[0].length, prefix, empty: match[0] === '' } : null;
  };

  let lo = 0;
  let hi = cuts.length - 1;
  let best = -1;
  let found: ReturnType<typeof probe> = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const result = probe(mid);
    if (result) {
      best = mid;
      found = result;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // An empty match (a leading `(?i)`, `a*`) agrees with nothing, but a shorter
  // prefix may still agree with something.
  for (let i = best; i >= 0; i--) {
    const result = i === best ? found : probe(i);
    if (result && !result.empty) return { end: result.end, prefix: result.prefix };
  }
  return null;
}

/**
 * Answer the regex half of the chain: did it compile, was there a source to
 * match against, and did it match. Returns null when the directive did fire, so
 * a caller can use it as the "why not" for anything that produced no change.
 */
export function explainRegexNoOp(
  pattern: string,
  source: string | undefined,
  sourceKeyName: string,
  limits: RegexLimits = {},
): NoOpReason | null {
  const compiled = safeRegex(pattern, '', limits);
  if (!compiled) return { kind: 'regex-invalid', error: validateRegex(pattern) ?? 'invalid regex' };

  if (source === undefined || source === '') {
    return { kind: 'source-key-empty', sourceKey: sourceKeyName };
  }

  if (compiled.exec(source)) return null;
  if (compiled.lastError !== undefined) return { kind: 'regex-limit', error: compiled.lastError };

  return explainNoMatch(pattern, source, true);
}
