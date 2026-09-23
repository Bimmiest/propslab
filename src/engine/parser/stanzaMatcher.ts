import type { ConfStanza, EventMetadata } from '../types';
import { safeRegex, escapeRegex } from '../../utils/splunkRegex';
import { effectiveDirective, parseSplunkBool } from '../utils/directiveValues';

// Splunk stanza precedence (highest wins): source > host > sourcetype > default
const STANZA_PRIORITY: Record<ConfStanza['type'], number> = {
  default: 0,
  sourcetype: 1,
  host: 2,
  source: 3,
};

/**
 * Splunk's documented default `priority`, which splits on whether the stanza
 * matches LITERALLY or by PATTERN — not on the stanza's kind (#198):
 *
 *   * 0 for pattern-matching stanzas.
 *   * 100 for literal-matching stanzas.
 *
 * So `[my_sourcetype]` and `[source::/var/log/app.log]` both default to 100,
 * while `[source::...foo...]` and `[host::web*]` default to 0. The spec's own
 * corollary is what pins the direction: setting a priority above 100 is what
 * lets a pattern-matched stanza override a literal-matching one, which only
 * follows if literal is the side sitting at 100.
 *
 * This was previously keyed on stanza type with the values the other way round,
 * which inverted both halves — it put `[<sourcetype>]` at 0 and every
 * `source::`/`host::` stanza at 100 regardless of whether it contained a
 * wildcard at all.
 */
const LITERAL_DEFAULT_PRIORITY = 100;
const PATTERN_DEFAULT_PRIORITY = 0;

/**
 * Whether a `source::`/`host::` pattern matches literally.
 *
 * Splunk's stanza pattern syntax is `...`, `*` and `?` for wildcards plus `|`
 * for alternation and `()` to scope it. A pattern carrying none of those matches
 * one exact string; `\\` is an escape for one literal backslash, so it does not
 * make a pattern. Note a lone `.` is a literal dot in this syntax rather than
 * a regex any-char, and a parenthesis with no partner is a literal character
 * too — all three fall out of parseStanzaPattern.
 */
function isLiteralPattern(pattern: string): boolean {
  const alternatives = parseStanzaPattern(pattern);
  return alternatives.length === 1 && (alternatives[0] ?? []).every((node) => node.kind === 'literal');
}

/** The default `priority` a stanza carries when it declares none. */
function defaultPriority(stanza: ConfStanza): number {
  switch (stanza.type) {
    // A sourcetype stanza names one sourcetype exactly; there is no pattern form.
    case 'sourcetype':
      return LITERAL_DEFAULT_PRIORITY;
    case 'host':
      return isLiteralPattern(stanza.hostPattern ?? stanza.name)
        ? LITERAL_DEFAULT_PRIORITY
        : PATTERN_DEFAULT_PRIORITY;
    case 'source':
      return isLiteralPattern(stanza.sourcePattern ?? stanza.name)
        ? LITERAL_DEFAULT_PRIORITY
        : PATTERN_DEFAULT_PRIORITY;
    // `[default]` is the global fallback rather than a match of either kind. It
    // is last by stanza type regardless, so this value only orders it against
    // other `[default]` stanzas, of which a conf should have at most one.
    case 'default':
      return PATTERN_DEFAULT_PRIORITY;
  }
}

/**
 * A stanza switched off with `disabled = 1` takes no part in resolution at all.
 *
 * Last definition wins within the stanza, matching `mergeDirectives` — and
 * mattering here for a layered conf, where `local/` re-enabling something
 * `default/` disabled is the whole point of writing it.
 */
export function isStanzaDisabled(stanza: ConfStanza): boolean {
  // Anything that is not a boolean spelling reads as false, as it does there.
  return parseSplunkBool(effectiveDirective(stanza.directives, 'disabled')?.value, false);
}

/** The effective precedence number for a stanza: explicit `priority`, or its kind's default. */
function stanzaPriority(stanza: ConfStanza): number {
  const declared = effectiveDirective(stanza.directives, 'priority');
  if (declared) {
    const parsed = Number.parseInt(declared.value.trim(), 10);
    // A malformed priority is ignored rather than treated as 0, which would
    // silently demote a literal-matching stanza below every pattern-matched one.
    if (Number.isFinite(parsed)) return parsed;
  }
  return defaultPriority(stanza);
}

export function matchStanzas(stanzas: ConfStanza[], metadata: EventMetadata): ConfStanza[] {
  const matched: {
    stanza: ConfStanza;
    explicitPriority: number;
    priority: number;
    specificity: number;
  }[] = [];

  for (const stanza of stanzas) {
    if (isStanzaDisabled(stanza)) continue;

    switch (stanza.type) {
      case 'default':
        matched.push({
          stanza,
          explicitPriority: stanzaPriority(stanza),
          priority: STANZA_PRIORITY.default,
          specificity: 0,
        });
        break;

      case 'sourcetype':
        if (metadata.sourcetype && stanza.name === metadata.sourcetype) {
          matched.push({
            stanza,
            explicitPriority: stanzaPriority(stanza),
            priority: STANZA_PRIORITY.sourcetype,
            specificity: stanza.name.length,
          });
        }
        break;

      case 'host':
        if (metadata.host && matchPattern(metadata.host, stanza.hostPattern ?? stanza.name, true)) {
          const specificity = getPatternSpecificity(stanza.hostPattern ?? stanza.name);
          matched.push({
            stanza,
            explicitPriority: stanzaPriority(stanza),
            priority: STANZA_PRIORITY.host,
            specificity,
          });
        }
        break;

      case 'source':
        // source:: matching is case-sensitive in Splunk
        if (metadata.source && matchPattern(metadata.source, stanza.sourcePattern ?? stanza.name, false)) {
          const specificity = getPatternSpecificity(stanza.sourcePattern ?? stanza.name);
          matched.push({
            stanza,
            explicitPriority: stanzaPriority(stanza),
            priority: STANZA_PRIORITY.source,
            specificity,
          });
        }
        break;
    }
  }

  // Stanza kind first, and `priority` cannot reach across it (#198). The spec is
  // explicit: "the priority key does *not* affect precedence across <spec>
  // types … [source::<source>] patterns take priority over stanzas with
  // [host::<host>] and [<sourcetype>] patterns, regardless of their respective
  // priority key values."
  //
  // So `priority` orders stanzas WITHIN a kind — which is where it earns its
  // keep, deciding between two `source::` stanzas that both match, or letting a
  // wildcard stanza beat a literal one by declaring above 100. Specificity then
  // breaks ties among stanzas sharing a priority.
  //
  // One caveat, recorded because the spec argues with itself: a paragraph
  // earlier it says priority "can also be used to resolve collisions between
  // [<sourcetype>] patterns and [host::<host>] patterns", which is a cross-type
  // claim. The statement implemented here is the explicit one, and the one
  // carrying a worked example.
  matched.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.explicitPriority !== b.explicitPriority) return b.explicitPriority - a.explicitPriority;
    return b.specificity - a.specificity;
  });

  return matched.map((m) => m.stanza);
}

/**
 * Resolve the stanzas that apply to an event, honouring an input-time
 * `sourcetype` assignment.
 *
 * `sourcetype = <name>` inside a `[source::…]` or `[host::…]` stanza is how
 * Splunk assigns a sourcetype at input, before any of the props resolution that
 * depends on it. So the assignment cannot be read out of the resolved directive
 * set — reading it there would mean resolving against the sourcetype it is
 * about to replace. Matching runs twice instead: once to find the assignment,
 * then again against the sourcetype it names.
 *
 * Returns the metadata actually used, so callers can report and carry the
 * rewritten sourcetype rather than the one they passed in.
 */
export function resolveStanzasForEvent(
  stanzas: ConfStanza[],
  metadata: EventMetadata,
): { stanzas: ConfStanza[]; metadata: EventMetadata; assignedSourcetype?: string } {
  const first = matchStanzas(stanzas, metadata);

  // Only a pattern-matched stanza can assign a sourcetype: on a `[<sourcetype>]`
  // stanza the key would be naming the sourcetype it already matched, and Splunk
  // uses `rename` for that instead.
  const assignment = first
    .filter((s) => s.type === 'source' || s.type === 'host')
    .map((s) => effectiveDirective(s.directives, 'sourcetype'))
    .find((d) => d !== undefined);

  const assigned = assignment?.value.trim();
  if (!assigned || assigned === metadata.sourcetype) {
    return { stanzas: first, metadata };
  }

  const rewritten = { ...metadata, sourcetype: assigned };
  // Matched once more and not iterated: the newly matched `[<sourcetype>]`
  // stanza cannot assign a sourcetype (see above), so a second pass is the
  // fixed point rather than one step of a loop that might not terminate.
  return { stanzas: matchStanzas(stanzas, rewritten), metadata: rewritten, assignedSourcetype: assigned };
}

/**
 * The sourcetype a `rename` points at, if the resolved stanzas declare one.
 *
 * `rename` applies at SEARCH time only: the events keep the sourcetype they were
 * indexed with, and only search-time configuration is read from the target. It
 * is also not a merge — Splunk documents that a renamed sourcetype uses the
 * target's search-time configuration and *not* the original's, so an EXTRACT on
 * the original stanza stops applying. That is the surprising half, and the
 * reason a config using `rename` is worth simulating rather than approximating.
 */
export function getRenamedSourcetype(matchedStanzas: ConfStanza[]): string | undefined {
  for (const stanza of matchedStanzas) {
    const value = effectiveDirective(stanza.directives, 'rename')?.value.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Case-insensitive matching lower-cases both sides rather than compiling with
 * `'i'`, which is equivalent here and keeps the regex eligible for V8's
 * linear-time fallback — that engine cannot compile a pattern carrying `d`, `i`
 * or `u`, and stanza matching runs per event.
 *
 * Equivalent *here* specifically because `patternToRegex` can only emit `.*`,
 * `[^/\\]*`, `[^/\\]`, `(?:`, `|`, `)` and `escapeRegex(char)`, and
 * `escapeRegex` only ever backslashes a metacharacter — none of which are
 * letters. So there is no case-bearing escape (`\w`, `\W`, `\s`, `\S`) for
 * lower-casing to invert — a risk that would be real if this built patterns
 * from arbitrary regex source.
 *
 * The residue is Unicode case folding: `toLowerCase()` and the `'i'` flag
 * disagree on a handful of characters (Turkish dotless i, `ß`/`SS`). Splunk
 * `source::`/`host::` specs are host names and file paths, so this is theory
 * rather than practice — but it is the reason to keep it to this function.
 */
function matchPattern(value: string, pattern: string, caseInsensitive: boolean): boolean {
  const subject = caseInsensitive ? value.toLowerCase() : value;
  const spec = caseInsensitive ? pattern.toLowerCase() : pattern;
  // The group matters: a top-level `a|b` would otherwise anchor only `a` at the
  // start and only `b` at the end.
  const regex = safeRegex(`^(?:${patternToRegex(spec)})$`);
  if (regex) return regex.test(subject);
  return subject === spec;
}

/**
 * One element of a parsed stanza pattern. A pattern is a list of alternatives
 * (split on `|`), each a sequence of these.
 */
type PatternNode =
  | { kind: 'literal'; char: string }
  | { kind: 'wildcard'; regex: string }
  | { kind: 'group'; alternatives: PatternNode[][] };

/**
 * Parse a `source::`/`host::` pattern once, so matching, specificity and the
 * literal/pattern test all read the same tokenisation — they disagreed before
 * (#30.1), and a second syntax is a second chance for that.
 *
 * props.conf.spec: "`|` is equivalent to 'or'. `( )` are used to limit scope
 * of `|`." Both were escaped as literal characters, so
 * `[source::/var/log/(messages|secure)]` matched only a file literally named
 * `(messages|secure)` and never `/var/log/secure` (#284).
 *
 * Parentheses are paired up front. One with no partner — `app(1.log` — is kept
 * as a literal character rather than rejected, because a stanza header is not
 * the place to throw: an unmatchable stanza would silently drop every setting
 * in it, while a literal reading at worst matches exactly what was written.
 */
function parseStanzaPattern(pattern: string): PatternNode[][] {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '(') open.push(i);
    else if (pattern[i] === ')') {
      const start = open.pop();
      if (start !== undefined) pairs.set(start, i);
    }
  }

  let pos = 0;
  // Parse up to (not including) `end`; the caller steps over a group's `)`.
  function parseAlternatives(end: number): PatternNode[][] {
    const alternatives: PatternNode[][] = [];
    let current: PatternNode[] = [];
    alternatives.push(current);
    while (pos < end) {
      const closer = pairs.get(pos);
      if (closer !== undefined) {
        pos++;
        current.push({ kind: 'group', alternatives: parseAlternatives(closer) });
        pos = closer + 1;
      } else if (pattern.startsWith('...', pos)) {
        current.push({ kind: 'wildcard', regex: '.*' });
        pos += 3;
      } else if (pattern[pos] === '*') {
        current.push({ kind: 'wildcard', regex: '[^/\\\\]*' });
        pos++;
      } else if (pattern[pos] === '?') {
        current.push({ kind: 'wildcard', regex: '[^/\\\\]' });
        pos++;
      } else if (pattern[pos] === '|') {
        current = [];
        alternatives.push(current);
        pos++;
      } else if (pattern.startsWith('\\\\', pos)) {
        // props.conf.spec: "\\ = matches a literal backslash '\'". Treating each
        // backslash as its own literal meant a Windows path written the way the
        // spec says, `[source::C:\\logs\\app.log]`, looked for two backslashes
        // per separator and never matched `C:\logs\app.log` (#303).
        //
        // A single backslash not followed by another stays a literal backslash,
        // as it always was here: the spec defines no other escape, and configs
        // written `C:\logs\app.log` match today, so reading a lone `\` as an
        // escape would break them for no gain. One node, so the pair scores one
        // literal character of specificity -- the one it matches.
        current.push({ kind: 'literal', char: '\\' });
        pos += 2;
      } else {
        // Includes an unpaired `(` or `)` — see above. A paired `)` is never
        // reached here: the group that owns it stops just before it.
        current.push({ kind: 'literal', char: pattern.charAt(pos) });
        pos++;
      }
    }
    return alternatives;
  }
  return parseAlternatives(pattern.length);
}

function alternativesToRegex(alternatives: PatternNode[][]): string {
  return alternatives
    .map((sequence) =>
      sequence
        .map((node) => {
          switch (node.kind) {
            case 'literal':
              return escapeRegex(node.char);
            case 'wildcard':
              return node.regex;
            case 'group':
              return `(?:${alternativesToRegex(node.alternatives)})`;
          }
        })
        .join(''),
    )
    .join('|');
}

function patternToRegex(pattern: string): string {
  return alternativesToRegex(parseStanzaPattern(pattern));
}

/**
 * Score literal characters; wildcards contribute nothing. Only `*`, `?`, and
 * the `...` multi-segment wildcard are wildcards — a lone `.` is a LITERAL dot
 * (Splunk source::/host:: syntax), so it must count. Otherwise `host::a.b.c.d`
 * scores below a shorter all-literal pattern and can wrongly lose precedence.
 *
 * Grouping parentheses and `|` are syntax, not text, and score nothing. An
 * alternation scores its LEAST specific branch: the literal text every match is
 * guaranteed to carry. Summing the branches would let `/var/log/(messages|secure)`
 * outrank a stanza it is no more specific than, merely for spelling out options
 * the event did not take.
 */
function alternativesSpecificity(alternatives: PatternNode[][]): number {
  let least = Infinity;
  for (const sequence of alternatives) {
    let score = 0;
    for (const node of sequence) {
      if (node.kind === 'literal') score++;
      else if (node.kind === 'group') score += alternativesSpecificity(node.alternatives);
    }
    least = Math.min(least, score);
  }
  return least;
}

function getPatternSpecificity(pattern: string): number {
  return alternativesSpecificity(parseStanzaPattern(pattern));
}

/**
 * Value of `key` for a set of already-matched stanzas (highest precedence
 * first).
 *
 * Across stanzas the first match wins; WITHIN a stanza the LAST definition wins,
 * for the same reason `mergeDirectives` does it that way — that is Splunk's rule
 * for a key repeated in a file, and it is also what makes a `local/` layer
 * override the `default/` one it was concatenated after. Taking the first match
 * within the stanza would silently return the lower layer's value.
 */
export function getDirectiveValue(stanzas: ConfStanza[], key: string): string | undefined {
  for (const stanza of stanzas) {
    const value = effectiveDirective(stanza.directives, key)?.value;
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Every directive of `directiveType` across the matched stanzas, in stanza
 * precedence order. This does NOT resolve overrides — for a layered conf a key
 * redefined in `local/` appears alongside the `default/` definition it beat, and
 * the loser carries `overriddenBy`. Callers that want only the winners should go
 * through `mergeDirectives`.
 */
export function getDirectivesByType(stanzas: ConfStanza[], directiveType: string): import('../types').ConfDirective[] {
  const results: import('../types').ConfDirective[] = [];
  for (const stanza of stanzas) {
    for (const directive of stanza.directives) {
      if (directive.directiveType === directiveType) {
        results.push(directive);
      }
    }
  }
  return results;
}

export function mergeDirectives(stanzas: ConfStanza[]): import('../types').ConfDirective[] {
  const seen = new Map<string, import('../types').ConfDirective>();
  // Stanzas arrive in precedence order (highest first), so across stanzas the
  // first match wins. WITHIN a single stanza, however, a repeated key takes its
  // LAST value — Splunk's documented "last definition in the file wins" rule.
  //
  // For a layered conf the layers were concatenated lowest-precedence-first, so
  // that same rule is what makes `local/` beat `default/`; the returned directive
  // carries the `layer` it won from and the `overrides` it beat.
  for (const stanza of stanzas) {
    const stanzaLatest = new Map<string, import('../types').ConfDirective>();
    for (const directive of stanza.directives) {
      stanzaLatest.set(directive.key, directive);
    }
    for (const [key, directive] of stanzaLatest) {
      if (!seen.has(key)) {
        seen.set(key, directive);
      }
    }
  }
  return Array.from(seen.values());
}
