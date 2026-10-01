import type { ConfStanza, EventMetadata } from '../types';
import { DEFAULT_DEPTH_LIMIT, DEFAULT_MATCH_LIMIT, safeRegex, validateRegex } from '../../utils/splunkRegex';
import { detached } from '../../utils/redosHeuristic';
import { effectiveDirective, parseSplunkBool } from '../utils/directiveValues';
import { asciiCompare } from '../utils/asciiCompare';

// Splunk stanza precedence (highest wins): source > host > sourcetype > default
const STANZA_PRIORITY: Record<ConfStanza['type'], number> = {
  default: 0,
  sourcetype: 1,
  host: 2,
  source: 3,
};

/**
 * Splunk's documented default `priority`, which splits on whether the stanza
 * matches LITERALLY or by PATTERN — not on the stanza's kind:
 *
 *   * 0 for pattern-matching stanzas.
 *   * 100 for literal-matching stanzas.
 *
 * So `[my_sourcetype]` and `[source::/var/log/app.log]` both default to 100,
 * while `[source::...foo...]` and `[host::web*]` default to 0. The spec's own
 * corollary is what pins the direction: setting a priority above 100 is what
 * lets a pattern-matched stanza override a literal-matching one, which only
 * follows if literal is the side sitting at 100.
 */
const LITERAL_DEFAULT_PRIORITY = 100;
const PATTERN_DEFAULT_PRIORITY = 0;

/**
 * Whether a `source::` pattern is a regex. Splunk reads it as PCRE only when it
 * contains `*` or `...` somewhere, and otherwise compares it with the source as
 * written (#442) — see {@link compileStanzaPattern}.
 */
function isSourceRegex(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('...');
}

/** PCRE syntax other than `.`, which a stanza pattern reads as a literal period. */
const REGEX_SYNTAX = new Set('\\^$|()[]{}?*+');

/**
 * Whether a `host::` pattern names one host. It is always matched as a regex
 * (#442), but with no wildcard and no regex syntax beyond the `.` it reads as a
 * period, it can only match the one name it spells, in any case.
 */
function isLiteralHost(pattern: string): boolean {
  if (pattern.includes('...')) return false;
  for (const c of pattern) if (REGEX_SYNTAX.has(c)) return false;
  return true;
}

/** The default `priority` a stanza carries when it declares none. */
function defaultPriority(stanza: ConfStanza): number {
  switch (stanza.type) {
    // A sourcetype stanza names one sourcetype exactly; there is no pattern form.
    case 'sourcetype':
      return LITERAL_DEFAULT_PRIORITY;
    case 'host':
      return isLiteralHost(stanza.hostPattern ?? stanza.name) ? LITERAL_DEFAULT_PRIORITY : PATTERN_DEFAULT_PRIORITY;
    case 'source':
      return isSourceRegex(stanza.sourcePattern ?? stanza.name) ? PATTERN_DEFAULT_PRIORITY : LITERAL_DEFAULT_PRIORITY;
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
  }[] = [];

  for (const stanza of stanzas) {
    if (isStanzaDisabled(stanza)) continue;

    switch (stanza.type) {
      case 'default':
        matched.push({ stanza, explicitPriority: stanzaPriority(stanza), priority: STANZA_PRIORITY.default });
        break;

      case 'sourcetype':
        if (metadata.sourcetype && stanza.name === metadata.sourcetype) {
          matched.push({ stanza, explicitPriority: stanzaPriority(stanza), priority: STANZA_PRIORITY.sourcetype });
        }
        break;

      case 'host':
        if (metadata.host && stanzaPattern('host', stanza.hostPattern ?? stanza.name).test(metadata.host)) {
          matched.push({ stanza, explicitPriority: stanzaPriority(stanza), priority: STANZA_PRIORITY.host });
        }
        break;

      case 'source':
        if (metadata.source && stanzaPattern('source', stanza.sourcePattern ?? stanza.name).test(metadata.source)) {
          matched.push({ stanza, explicitPriority: stanzaPriority(stanza), priority: STANZA_PRIORITY.source });
        }
        break;
    }
  }

  // Stanza kind first, and `priority` cannot reach across it. The spec is
  // explicit: "the priority key does *not* affect precedence across <spec>
  // types … [source::<source>] patterns take priority over stanzas with
  // [host::<host>] and [<sourcetype>] patterns, regardless of their respective
  // priority key values."
  //
  // So `priority` orders stanzas WITHIN a kind — which is where it earns its
  // keep, deciding between two `source::` stanzas that both match, or letting a
  // wildcard stanza beat a literal one by declaring above 100.
  //
  // One caveat, recorded because the spec argues with itself: a paragraph
  // earlier it says priority "can also be used to resolve collisions between
  // [<sourcetype>] patterns and [host::<host>] patterns", which is a cross-type
  // claim. The statement implemented here is the explicit one, and the one
  // carrying a worked example.
  //
  // Equal priority falls to the ASCII order of the stanza name, the stanza
  // sorting first taking precedence. props.conf.spec: "suppose two [<spec>]
  // stanzas supply the same setting. In this case, Splunk software chooses the
  // value to apply based on the ASCII order of the patterns in question." There
  // is no rule before it ranking the more specific pattern higher (#443):
  // `[source::.../app.log]` beats `[source::/var/log/x/...]` for a source both
  // match. File order must not decide it either: reordering two stanzas in
  // props.conf does not change which one wins.
  matched.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.explicitPriority !== b.explicitPriority) return b.explicitPriority - a.explicitPriority;
    return asciiCompare(a.stanza.name, b.stanza.name);
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
 * Why a `[source::…]` or `[host::…]` stanza can never match: its pattern is a
 * regex PCRE rejects. `regex` is the pattern as translated (see
 * {@link compileStanzaPattern}), which is what PCRE's offsets count into. Null
 * for any other stanza.
 */
export function stanzaPatternProblem(stanza: ConfStanza): { regex: string; error: string } | null {
  switch (stanza.type) {
    case 'host':
      return stanzaPattern('host', stanza.hostPattern ?? stanza.name).problem;
    case 'source':
      return stanzaPattern('source', stanza.sourcePattern ?? stanza.name).problem;
    case 'sourcetype':
    case 'default':
      return null;
  }
}

/** A stanza pattern ready to test names against, or the reason it never matches. */
interface StanzaPattern {
  test(name: string): boolean;
  problem: { regex: string; error: string } | null;
}

const NEVER = (): boolean => false;

/** Splunk's default MATCH_LIMIT and DEPTH_LIMIT; see {@link compileStanzaPattern}. */
const STANZA_PATTERN_LIMITS = { matchLimit: DEFAULT_MATCH_LIMIT, depthLimit: DEFAULT_DEPTH_LIMIT };

/**
 * Compiled patterns, keyed on kind and pattern: stanza resolution runs for each
 * distinct event metadata, over every stanza. Bounded, so the patterns of confs
 * typed in the editor or sent by an MCP client do not accumulate; an evicted
 * pattern is compiled again, to the same answer.
 */
const STANZA_PATTERN_CACHE_LIMIT = 256;
const stanzaPatterns = new Map<string, StanzaPattern>();

/** How many compiled stanza patterns the cache holds; for the cache-bound test. */
export function cachedStanzaPatternCount(): number {
  return stanzaPatterns.size;
}

function stanzaPattern(kind: 'source' | 'host', pattern: string): StanzaPattern {
  const hit = stanzaPatterns.get(`${kind}\u0000${pattern}`);
  if (hit) return hit;
  // A copy of its own, because the pattern is cut out of the conf text and,
  // kept as a key, a view of it would keep the whole text alive.
  const own = detached(pattern);
  const compiled = compileStanzaPattern(kind, own);
  if (stanzaPatterns.size >= STANZA_PATTERN_CACHE_LIMIT) {
    const oldest = stanzaPatterns.keys().next();
    if (!oldest.done) stanzaPatterns.delete(oldest.value);
  }
  stanzaPatterns.set(`${kind}\u0000${own}`, compiled);
  return compiled;
}

/**
 * How Splunk reads a stanza pattern. props.conf.spec: "Match expressions must
 * match the entire name, not just a substring. Match expressions are based on
 * a full implementation of Perl-compatible regular expressions (PCRE) with the
 * translation of "...", "*", and "." Thus, "." matches a period, "*" matches
 * non-directory separators, and "..." matches any number of any characters."
 *
 * - A `host::` pattern is always that regex, wildcard or not, and matches
 *   case-insensitively unless it carries `(?-i)`, which PCRE honours inline.
 *   The spec: "[host::<host>] stanzas match in a case-insensitive manner" and
 *   "To force a [host::<host>] stanza to match in a case-sensitive manner use
 *   the "(?-i)" option in its pattern."
 * - A `source::` pattern is that regex, case-sensitive, only when it contains
 *   `*` or `...` (#442). Without either it is compared with the source exactly
 *   as written: `?`, `\d`, `[0-9]` and `(a)` are plain characters, and `\\` is
 *   two backslashes where in a regex it is one. A literal pattern containing
 *   `|` matches nothing, neither as an alternation nor as text (#442).
 *
 * A regex PCRE rejects matches nothing, and `problem` says why, for the conf
 * lint. A match is bounded by Splunk's default MATCH_LIMIT and DEPTH_LIMIT,
 * which no pattern written for a path or a host name comes near: the Effective
 * config and Timestamp tabs resolve stanzas on the page's own thread, where an
 * unbounded backtrack would freeze it.
 */
function compileStanzaPattern(kind: 'source' | 'host', pattern: string): StanzaPattern {
  if (kind === 'source' && !isSourceRegex(pattern)) {
    return { test: pattern.includes('|') ? NEVER : (name) => name === pattern, problem: null };
  }
  const regex = translateStanzaPattern(pattern);
  // Checked bare, not only anchored: inside the anchoring group an unbalanced
  // `)` followed by an unbalanced `(` would close and reopen it, and compile
  // into some other pattern.
  const error = validateRegex(regex);
  if (error !== null) return { test: NEVER, problem: { regex, error } };
  // Null only where the wrapping is read as part of the pattern — an `(?x)`
  // comment or an unterminated `\Q` running to its end — and then the stanza
  // matches nothing.
  const anchored = safeRegex(`\\A(?:${regex})\\z`, kind === 'host' ? 'i' : '', STANZA_PATTERN_LIMITS);
  return { test: anchored ? (name) => anchored.test(name) : NEVER, problem: null };
}

/**
 * A stanza pattern as the PCRE it stands for: `...` becomes `.*`, `*` becomes
 * `[^/\\]*` and `.` becomes `\.`, and everything else is left to PCRE. Only
 * where PCRE would read them as syntax, though: an escape (`\.`, `\*`) and the
 * inside of a character class (`[.*]`) already mean those characters
 * literally, and are copied as written.
 */
function translateStanzaPattern(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '\\') {
      out += pattern.slice(i, i + 2);
      i += 2;
    } else if (pattern[i] === '[') {
      const end = classEnd(pattern, i);
      out += pattern.slice(i, end);
      i = end;
    } else if (pattern.startsWith('...', i)) {
      out += '.*';
      i += 3;
    } else if (pattern[i] === '*') {
      out += '[^/\\\\]*';
      i++;
    } else if (pattern[i] === '.') {
      out += '\\.';
      i++;
    } else {
      out += pattern.charAt(i);
      i++;
    }
  }
  return out;
}

/**
 * Where the character class opening at `start` ends: just past its closing
 * `]`, read as PCRE reads it. A `]` first in the class (after any `^`) is a
 * member; an escape is skipped whole; and a POSIX class such as `[:digit:]`
 * is skipped to its `:]`, PCRE's rule being that one with a `]` before that is
 * not a POSIX class. An unterminated class runs to the end of the pattern,
 * which PCRE then rejects.
 */
function classEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === '^') i++;
  if (pattern[i] === ']') i++;
  while (i < pattern.length) {
    if (pattern[i] === ']') return i + 1;
    if (pattern[i] === '\\') {
      i += 2;
    } else if (pattern.startsWith('[:', i)) {
      const close = pattern.indexOf(':]', i + 2);
      i = close !== -1 && !pattern.slice(i + 2, close).includes(']') ? close + 2 : i + 1;
    } else {
      i++;
    }
  }
  return pattern.length;
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
