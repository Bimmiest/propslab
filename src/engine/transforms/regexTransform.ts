// Applying one transforms.conf stanza to one event: SOURCE_KEY, LOOKAHEAD,
// REGEX, and where the result goes (DEST_KEY, or fields via FORMAT or named
// groups). FORMAT parsing, DELIMS/FIELDS extraction and key cleaning live in
// the sibling format.ts, delims.ts and keyCleaning.ts.

import type { SplunkEvent, ConfStanza, ConfDirective } from '../types';
import { safeRegex, convertSplunkToJsRegex, validateRegex } from '../../utils/splunkRegex';
import { longestPartialMatch, type NoOpReason } from '../noOpExplainer';
import { getField, hasField, setField, addFieldValue } from '../utils/fieldBag';
import { stripLeadingUnderscoreForField } from '../utils/internalFields';
import { getSourceKeyValue } from '../utils/metadataFields';
import { effectiveDirective, parseSplunkBool } from '../utils/directiveValues';
import { expandFormat, parseFormatPairs } from './format';
import { keyCleaner } from './keyCleaning';
import { applyDelimsExtraction } from './delims';

// kvMode applies the same key cleaning, and has always imported it from here.
export { cleanFieldKey } from './keyCleaning';

export interface TransformResult {
  fields: Record<string, string | string[]>;
  destKey?: string;
  destValue?: string;
  matched: boolean;
  /**
   * Why the transform had no effect, set only when `matched` is false (#84).
   * Computed here rather than by the caller because this is where SOURCE_KEY
   * has been resolved and LOOKAHEAD applied — recomputing either outside would
   * be a second implementation to keep in step.
   */
  noOp?: NoOpReason;
}

interface CompiledRegex { plain: RegExp; global: RegExp }

// Cache compiled regexes per stanza to avoid re-compiling on every event.
// WeakMap so entries are GC'd when stanza objects are collected.
//
// Keyed on the PATTERN as well as the stanza. Keying on the stanza alone was
// correct only by accident of lifecycle — parseConf builds fresh stanza objects
// every run, so a stanza's REGEX could not change without invalidating the key —
// and nothing said so. A caller that mutated a stanza in place, or reused a
// ParsedConf across runs, would silently get the previous pattern back, and a
// stale regex is a *valid* regex: no error, just quietly wrong extractions.
const regexCache = new WeakMap<ConfStanza, Map<string, CompiledRegex | null>>();

// These DEST_KEY targets are single-valued slots in Splunk's pipeline.
// FORMAT is applied to the first match only — multi-value accumulation would
// produce a mangled string (e.g. "auditd\nsourcetype::auditd\n…") that the
// router cannot correctly parse.
const SINGLE_VALUE_DEST_KEYS = new Set([
  'MetaData:Host',
  'MetaData:Index',
  'MetaData:Source',
  'MetaData:Sourcetype',
  '_meta',
  '_time',
  'queue',
]);

function getCompiledRegex(transformStanza: ConfStanza, jsPattern: string): CompiledRegex | null {
  let byPattern = regexCache.get(transformStanza);
  if (!byPattern) {
    byPattern = new Map();
    regexCache.set(transformStanza, byPattern);
  }
  const cached = byPattern.get(jsPattern);
  if (cached !== undefined) return cached;

  const plain = safeRegex(jsPattern);
  const global = safeRegex(jsPattern, 'g');
  const result = plain && global ? { plain, global } : null;
  byPattern.set(jsPattern, result);
  return result;
}

/**
 * Resolve the current contents of DEST_KEY (used for `$0` in FORMAT). Returns
 * `undefined` when there is no DEST_KEY, so `$0` falls back to the whole match.
 */
function resolvePriorDestValue(event: SplunkEvent, destKey: string | undefined): string | undefined {
  if (!destKey) return undefined;
  if (destKey === '_raw') return event._raw;
  const norm = destKey.replace(/^_(?=MetaData:)/i, '');
  switch (norm) {
    case 'MetaData:Host': return event.metadata.host;
    case 'MetaData:Index': return event.metadata.index;
    case 'MetaData:Source': return event.metadata.source;
    case 'MetaData:Sourcetype': return event.metadata.sourcetype;
  }
  const v = getField(event.fields, destKey);
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

function addMultiValue(
  fields: Record<string, string | string[]>,
  key: string,
  value: string,
): void {
  // hasOwn-guarded + `__proto__`-safe: a named group like `(?<toString>…)` is
  // stored as a real field rather than reading back the inherited function.
  addFieldValue(fields, key, value);
}

/** Resolve the value a transform reads from, honouring SOURCE_KEY (default _raw). */
function resolveSourceValue(event: SplunkEvent, sourceKeyDir?: ConfDirective): string {
  const sourceKey = sourceKeyDir?.value.trim() ?? '_raw';
  // Built-in pipeline slots (`_raw`, `_meta`, `queue`, `MetaData:*`) are not
  // stored in `fields`; reading them from there returned "" and made the whole
  // transform silently never match — including the canonical sourcetype-override
  // pattern this registry documents as its own example.
  const builtin = getSourceKeyValue(event, sourceKey);
  if (builtin !== undefined) return builtin;
  const v = getField(event.fields, sourceKey);
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export function applyRegexTransform(
  event: SplunkEvent,
  transformStanza: ConfStanza,
  onInvalidRegex?: (pattern: string) => void,
  phase: 'index-time' | 'search-time' = 'index-time',
): TransformResult {
  // Splunk's last-definition-wins rule: a repeated key within a stanza (including
  // one produced by merging duplicate same-name stanzas) takes its LAST value.
  const regexDir = effectiveDirective(transformStanza.directives, 'REGEX');
  const formatDir = effectiveDirective(transformStanza.directives, 'FORMAT');
  const sourceKeyDir = effectiveDirective(transformStanza.directives, 'SOURCE_KEY');
  // DEST_KEY is index-time only (transforms.conf.spec: "only relevant for
  // index-time field extractions"). Reached through a search-time REPORT-, the
  // stanza performs field extraction and nothing else — so FORMAT is read as
  // `field::value` pairs, exactly as it would be with no DEST_KEY present.
  const destKeyDir = phase === 'index-time' ? effectiveDirective(transformStanza.directives, 'DEST_KEY') : undefined;
  const writeMeta = parseSplunkBool(effectiveDirective(transformStanza.directives, 'WRITE_META')?.value, false);
  // REPEAT_MATCH: re-run the regex to find every match (default: first match only).
  // MV_ADD: when a field is extracted more than once, accumulate into a multivalue
  // field rather than discarding the later value (default: keep the first).
  //
  // MV_ADD, like DELIMS/FIELDS/CLEAN_KEYS/KEEP_EMPTY_VALS below, is documented
  // as valid only for search-time field extractions, so an index-time
  // TRANSFORMS- pass ignores it rather than quietly honouring a setting real
  // Splunk drops. transformsProcessor warns when a stanza is used that way.
  const repeatMatch = parseSplunkBool(effectiveDirective(transformStanza.directives, 'REPEAT_MATCH')?.value, false);
  // Whether REGEX is run across the whole source or once. REPEAT_MATCH is
  // documented as index-time only, and there it is the switch: without it the
  // REGEX runs once. At search time it is inert, yet Splunk still extracts every
  // match — the report-repeat-match and report-transform-search-time captures
  // (10.4.0) both show repeated extraction, the first with REPEAT_MATCH set but
  // irrelevant and the second without it — and MV_ADD alone decides whether the
  // later values are kept (#285).
  const scanAll = phase === 'search-time' || repeatMatch;
  const mvAdd =
    phase === 'search-time' && parseSplunkBool(effectiveDirective(transformStanza.directives, 'MV_ADD')?.value, false);

  const result: TransformResult = { fields: {}, matched: false };
  const cleanName = keyCleaner(transformStanza, writeMeta, phase);

  // DELIMS-based (delimiter) extraction is used in place of REGEX — and is
  // search-time only, so an index-time reference to a DELIMS stanza extracts
  // nothing at all. Falling through to the REGEX branch is correct: a DELIMS
  // stanza has no REGEX, so the transform does nothing.
  const delimsDir = phase === 'search-time' ? effectiveDirective(transformStanza.directives, 'DELIMS') : undefined;
  if (delimsDir) {
    return applyDelimsExtraction(resolveSourceValue(event, sourceKeyDir), transformStanza, delimsDir, cleanName);
  }

  if (!regexDir) return result;

  // LOOKAHEAD bounds how far into the source an index-time REGEX searches; the
  // bound exists even when the attribute is absent (Splunk's default is 4096
  // characters). It is an index-time attribute, so search-time extractions scan
  // the whole source. A non-positive or unparseable value falls back to the
  // default rather than to "no limit".
  let sourceValue = resolveSourceValue(event, sourceKeyDir);
  if (phase === 'index-time') {
    const lookaheadRaw = effectiveDirective(transformStanza.directives, 'LOOKAHEAD')?.value.trim();
    const parsedLookahead = lookaheadRaw !== undefined ? parseInt(lookaheadRaw, 10) : NaN;
    const lookahead = Number.isFinite(parsedLookahead) && parsedLookahead > 0 ? parsedLookahead : 4096;
    if (sourceValue.length > lookahead) sourceValue = sourceValue.slice(0, lookahead);
  }

  const jsPattern = convertSplunkToJsRegex(regexDir.value.trim());
  const compiled = getCompiledRegex(transformStanza, jsPattern);
  if (!compiled) {
    // Invalid PCRE-ism or a pattern the ReDoS heuristic refused — the transform
    // silently does nothing, so let the caller surface a diagnostic.
    onInvalidRegex?.(regexDir.value.trim());
    result.noOp = {
      kind: 'regex-invalid',
      error:
        validateRegex(regexDir.value.trim()) ??
        'refused by the ReDoS guard — it can backtrack catastrophically',
    };
    return result;
  }

  // Match once with the plain (non-global) regex; reused below to decide named vs
  // numbered handling and as the first match for non-REPEAT_MATCH extraction.
  const firstMatch = compiled.plain.exec(sourceValue);
  if (!firstMatch) {
    // DEFAULT_VALUE: an index-time transform whose REGEX fails writes this value
    // to DEST_KEY instead of doing nothing, so the destination is written for
    // every event. `matched` doubles as "has an effect to route" for the caller.
    const defaultValue =
      phase === 'index-time' ? effectiveDirective(transformStanza.directives, 'DEFAULT_VALUE')?.value.trim() : undefined;
    const destKeyForDefault = destKeyDir?.value.trim();
    if (defaultValue !== undefined && defaultValue !== '' && destKeyForDefault) {
      result.matched = true;
      result.destKey = destKeyForDefault;
      result.destValue = defaultValue;
      return result;
    }
    // An empty SOURCE_KEY is reported ahead of the pattern: a working regex
    // against nothing is not a regex problem, and saying it did not match sends
    // the reader to rewrite something that is already correct.
    if (sourceValue === '') {
      result.noOp = { kind: 'source-key-empty', sourceKey: sourceKeyDir?.value.trim() ?? '_raw' };
      return result;
    }
    const partial = longestPartialMatch(regexDir.value.trim(), sourceValue);
    result.noOp = partial
      ? { kind: 'no-match', partialEnd: partial.end, partialPattern: partial.prefix }
      : { kind: 'no-match' };
    return result;
  }

  result.matched = true;

  const destKey = destKeyDir?.value.trim();
  const priorDestValue = resolvePriorDestValue(event, destKey);
  const hasNamedGroups = firstMatch.groups !== undefined;
  // Index-time FORMAT defaults to `<stanza-name>::$1` when omitted (transforms.conf.spec).
  // Named capture groups auto-extract without a FORMAT, so the default only applies
  // to a REGEX that uses numbered groups (at least group 1 must exist to reference).
  //
  // The search-time default is empty (#288): a REPORT- with only numbered groups
  // and no FORMAT extracts nothing, rather than inventing a field named after the
  // stanza. Named groups still extract there — the
  // report-named-groups-without-format capture (10.4.0) pins that.
  const format =
    formatDir?.value.trim() ??
    (phase === 'index-time' && !hasNamedGroups && firstMatch.length > 1
      ? `${transformStanza.name}::$1`
      : undefined);

  if (format) {
    if (destKey === '_raw') {
      // DEST_KEY=_raw replaces the ENTIRE event with the FORMAT expansion of the
      // first match — it is NOT a sed-style substitution. Anything the regex does
      // not capture and FORMAT does not reproduce is discarded. (SEDCMD is the
      // tool for substituting in place while keeping the rest of the event.)
      const m = compiled.plain.exec(sourceValue);
      if (m) {
        result.destKey = destKey;
        result.destValue = expandFormat(format, m, priorDestValue);
      }
    } else if (destKey) {
      // Normalise _MetaData:X alias so lookup works for both forms.
      const normalisedDestKey = destKey.replace(/^_(?=MetaData:)/i, '');

      if (SINGLE_VALUE_DEST_KEYS.has(normalisedDestKey)) {
        // Single-valued metadata slot: FORMAT applies to the first match only.
        const m = compiled.plain.exec(sourceValue);
        if (m) {
          result.destKey = destKey;
          result.destValue = expandFormat(format, m, priorDestValue);
        }
      } else {
        // DEST_KEY=<field>: one value per match, accumulated as a multi-value
        // field — under REPEAT_MATCH only, since without it the REGEX runs once.
        const { global } = compiled;
        global.lastIndex = 0;
        let m: RegExpExecArray | null;
        let firstValue: string | undefined;
        const extraValues: string[] = [];
        while ((m = global.exec(sourceValue)) !== null) {
          const formatted = expandFormat(format, m, priorDestValue);
          if (firstValue === undefined) {
            firstValue = formatted;
          } else {
            extraValues.push(formatted);
          }
          if (!repeatMatch) break;
          // Guard against zero-length matches (e.g. a regex like `(.*)` that can
          // match the empty string) — without advancing, lastIndex never moves and
          // global.exec loops forever.
          if (m.index === global.lastIndex) global.lastIndex++;
        }
        if (firstValue !== undefined) {
          result.destKey = destKey;
          result.destValue = extraValues.length === 0 ? firstValue : [firstValue, ...extraValues].join('\n');
        }
      }
    } else {
      // No DEST_KEY: FORMAT is "field1::$1 field2::$2". The pair structure is
      // parsed from the FORMAT *before* captures are substituted, then each
      // half is expanded on its own — Splunk tokenizes FORMAT at config time and
      // substitutes afterwards. Expanding first would let a captured value's own
      // spaces end the value early, and let a captured `::` synthesize a field.
      // `$0` means "what was in the DEST_KEY before the REGEX ran", and this
      // branch is the one with no DEST_KEY — so the reference names nothing and
      // Splunk creates no field for the pair at all. Expanding it to the whole
      // match instead showed the user a field that cannot exist in their real
      // deployment, which is worse than showing nothing (#175).
      const pairs = parseFormatPairs(format).filter(
        (p) => !/\$0(?!\d)/.test(p.key) && !/\$0(?!\d)/.test(p.value),
      );
      const keepFirstMatchOnly = phase === 'search-time' && !mvAdd;
      const { global } = compiled;
      global.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = global.exec(sourceValue)) !== null) {
        for (const pair of pairs) {
          // Cleaned because FORMAT can name a field from the DATA (`$1::$2`), so
          // the key is only as well-formed as whatever the capture group caught.
          const field = cleanName(expandFormat(pair.key, m));
          if (!field) continue;
          // MV_ADD governs this path too, not just the named-capture-group one:
          // at its default of false Splunk keeps the first match and discards
          // the rest rather than building a multivalue field (#174). It is a
          // search-time attribute, so an index-time transform still accumulates
          // (when REPEAT_MATCH gives it more than one match to accumulate) --
          // gating both phases on it would make MV_ADD do something where
          // Splunk ignores it entirely.
          if (keepFirstMatchOnly && hasField(result.fields, field)) continue;
          addMultiValue(result.fields, field, expandFormat(pair.value, m));
        }
        // Index time without REPEAT_MATCH: the REGEX runs once (#285).
        if (!scanAll) break;
        // Guard against zero-length outer matches looping forever.
        if (m.index === global.lastIndex) global.lastIndex++;
      }
    }
  } else {
    // No FORMAT — extract named capture groups, scanning the same matches the
    // FORMAT path does (`scanAll`): every match at search time, and at index
    // time only under REPEAT_MATCH. When a field is captured more than once,
    // MV_ADD=true accumulates a multivalue field while MV_ADD=false keeps the
    // first value and discards the rest. This used to take the first match only
    // at search time unless REPEAT_MATCH was set, so MV_ADD on named groups did
    // nothing there while the same MV_ADD on a FORMAT stanza worked (#285).
    const matches: RegExpMatchArray[] = scanAll
      ? [...sourceValue.matchAll(compiled.global)]
      : [firstMatch];

    // Whether a field captured again by a later match keeps the later value.
    // The same rule as `keepFirstMatchOnly` in the FORMAT path, stated the other
    // way round: at search time MV_ADD decides; at index time MV_ADD is inert,
    // and REPEAT_MATCH — the only way there is more than one match to see —
    // "runs the REGEX multiple times", each match writing the field (#303).
    // Named groups used to keep the first value here while the FORMAT path
    // accumulated every match, so the same REPEAT_MATCH extraction produced a
    // single value or a multivalue depending only on how the REGEX was written.
    const accumulate = phase === 'index-time' || mvAdd;

    // `fieldName` arrives final: literal group names get the WRITE_META
    // underscore strip, _KEY_ names the full key cleaning, below.
    const assignField = (fieldName: string, value: string) => {
      if (!fieldName) return;
      if (!hasField(result.fields, fieldName)) {
        setField(result.fields, fieldName, value);
      } else if (accumulate) {
        addMultiValue(result.fields, fieldName, value);
      }
      // else: search time, field already set and MV_ADD is false — discard the later value.
    };

    for (const match of matches) {
      if (!match.groups) continue;
      const groups = match.groups;

      // _KEY_<suffix>/_VAL_<suffix>: the KEY group's captured text is the field
      // NAME and the paired VAL group's text is the value (transforms.conf.spec
      // dynamic KV). Resolve these before treating groups as literal field names.
      const dynamicSuffixes = new Set<string>();
      for (const gname of Object.keys(groups)) {
        const km = /^_KEY_(.+)$/.exec(gname);
        if (km?.[1]) dynamicSuffixes.add(km[1]);
      }
      for (const suffix of dynamicSuffixes) {
        const keyText = groups[`_KEY_${suffix}`];
        const valText = groups[`_VAL_${suffix}`];
        if (keyText === undefined || valText === undefined) continue;
        // The name comes from the DATA, exactly as with a FORMAT `$1::$2`, so it
        // gets the same cleaning — CLEAN_KEYS at search time, the WRITE_META
        // strip at index time. Passing it through raw let `user-name=bob`
        // produce a field `user-name` that Splunk would call `user_name` (#285).
        assignField(cleanName(keyText), valText);
      }

      // Remaining named groups become fields verbatim (skip the _KEY_/_VAL_ pair
      // groups, which are extraction machinery rather than real field names).
      for (const [name, value] of Object.entries(groups)) {
        if (value === undefined) continue;
        if (/^_(?:KEY|VAL)_/.test(name)) continue;
        assignField(writeMeta ? stripLeadingUnderscoreForField(name) : name, value);
      }
    }
  }

  return result;
}
