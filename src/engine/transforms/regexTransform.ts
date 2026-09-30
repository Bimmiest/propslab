// Applying one transforms.conf stanza to one event: SOURCE_KEY, LOOKAHEAD,
// REGEX, and where the result goes (DEST_KEY, or fields via FORMAT or named
// groups). FORMAT parsing, DELIMS/FIELDS extraction and key cleaning live in
// the sibling format.ts, delims.ts and keyCleaning.ts.

import type { SplunkEvent, ConfStanza, ConfDirective } from '../types';
import { extractionLimits, safeRegex, validateRegex, type RegexMatch, type SplunkRegex } from '../../utils/splunkRegex';
import { explainNoMatch, type NoOpReason } from '../noOpExplainer';
import { getField, hasField, setField, addFieldValue } from '../utils/fieldBag';
import { stripLeadingUnderscoreForField } from '../utils/internalFields';
import { getSourceKeyValue } from '../utils/metadataFields';
import { effectiveDirective, effectiveValue, parseSplunkBool } from '../utils/directiveValues';
import { expandFormat, parseFormatPairs } from './format';
import { keyCleaner } from './keyCleaning';
import { normaliseDestKey } from './destKeys';
import { applyDelimsExtraction } from './delims';

// kvMode applies the same key cleaning, and has always imported it from here.
export { cleanFieldKey } from './keyCleaning';

export interface TransformResult {
  fields: Record<string, string | string[]>;
  destKey?: string;
  destValue?: string;
  matched: boolean;
  /**
   * Why the transform had no effect, set only when `matched` is false.
   * Computed here rather than by the caller because this is where SOURCE_KEY
   * has been resolved and LOOKAHEAD applied — recomputing either outside would
   * be a second implementation to keep in step.
   */
  noOp?: NoOpReason;
}

// Cache compiled regexes per stanza to avoid re-compiling on every event.
// WeakMap so entries are GC'd when stanza objects are collected.
//
// Keyed on the PATTERN as well as the stanza. Keying on the stanza alone was
// correct only by accident of lifecycle — parseConf builds fresh stanza objects
// every run, so a stanza's REGEX could not change without invalidating the key —
// and nothing said so. A caller that mutated a stanza in place, or reused a
// ParsedConf across runs, would silently get the previous pattern back, and a
// stale regex is a *valid* regex: no error, just quietly wrong extractions.
const regexCache = new WeakMap<ConfStanza, Map<string, SplunkRegex | null>>();

// These DEST_KEY targets are single-valued slots in Splunk's pipeline.
// FORMAT is applied to the first match only — multi-value accumulation would
// produce a mangled string (e.g. "auditd\nsourcetype::auditd\n…") that the
// router cannot correctly parse. `_meta` is not one: it holds a list of
// indexed fields, and REPEAT_MATCH exists precisely to add one pair per match.
const SINGLE_VALUE_DEST_KEYS = new Set([
  'MetaData:Host',
  'MetaData:Index',
  'MetaData:Source',
  'MetaData:Sourcetype',
  '_time',
  'queue',
]);

/**
 * The stanza's REGEX, compiled under the stanza's own MATCH_LIMIT and
 * DEPTH_LIMIT (Splunk's defaults when unset).
 */
function getCompiledRegex(transformStanza: ConfStanza, pattern: string): SplunkRegex | null {
  let byPattern = regexCache.get(transformStanza);
  if (!byPattern) {
    byPattern = new Map();
    regexCache.set(transformStanza, byPattern);
  }
  const matchLimit = effectiveValue(transformStanza.directives, 'MATCH_LIMIT');
  const depthLimit = effectiveValue(transformStanza.directives, 'DEPTH_LIMIT');
  const key = `${matchLimit ?? ''}\u0000${depthLimit ?? ''}\u0000${pattern}`;
  const cached = byPattern.get(key);
  if (cached !== undefined) return cached;

  const result = safeRegex(pattern, '', extractionLimits(matchLimit, depthLimit));
  byPattern.set(key, result);
  return result;
}

/**
 * Resolve the current contents of DEST_KEY (used for `$0` in FORMAT). Returns
 * `undefined` when there is no DEST_KEY, so `$0` falls back to the whole match.
 */
function resolvePriorDestValue(event: SplunkEvent, destKey: string | undefined): string | undefined {
  if (!destKey) return undefined;
  if (destKey === '_raw') return event._raw;
  switch (normaliseDestKey(destKey)) {
    case 'MetaData:Host':
      return event.metadata.host;
    case 'MetaData:Index':
      return event.metadata.index;
    case 'MetaData:Source':
      return event.metadata.source;
    case 'MetaData:Sourcetype':
      return event.metadata.sourcetype;
  }
  const v = getField(event.fields, destKey);
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

function addMultiValue(fields: Record<string, string | string[]>, key: string, value: string): void {
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

type Phase = 'index-time' | 'search-time';

/** The directives of a transform stanza that shape one REGEX run, read once. */
interface RegexSettings {
  regexDir: ConfDirective | undefined;
  formatDir: ConfDirective | undefined;
  sourceKeyDir: ConfDirective | undefined;
  destKeyDir: ConfDirective | undefined;
  writeMeta: boolean;
  repeatMatch: boolean;
  /** Whether REGEX is run across the whole source or once. */
  scanAll: boolean;
  mvAdd: boolean;
}

function readRegexSettings(transformStanza: ConfStanza, phase: Phase): RegexSettings {
  const { directives } = transformStanza;
  const flag = (key: string) => parseSplunkBool(effectiveDirective(directives, key)?.value, false);
  // REPEAT_MATCH: re-run the regex to find every match (default: first match only).
  // MV_ADD: when a field is extracted more than once, accumulate into a multivalue
  // field rather than discarding the later value (default: keep the first).
  //
  // MV_ADD, like DELIMS/FIELDS/CLEAN_KEYS/KEEP_EMPTY_VALS below, is documented
  // as valid only for search-time field extractions, so an index-time
  // TRANSFORMS- pass ignores it rather than quietly honouring a setting real
  // Splunk drops. transformsProcessor warns when a stanza is used that way.
  const repeatMatch = flag('REPEAT_MATCH');
  return {
    // Splunk's last-definition-wins rule: a repeated key within a stanza (including
    // one produced by merging duplicate same-name stanzas) takes its LAST value.
    regexDir: effectiveDirective(directives, 'REGEX'),
    formatDir: effectiveDirective(directives, 'FORMAT'),
    sourceKeyDir: effectiveDirective(directives, 'SOURCE_KEY'),
    // DEST_KEY is index-time only (transforms.conf.spec: "only relevant for
    // index-time field extractions"). Reached through a search-time REPORT-, the
    // stanza performs field extraction and nothing else — so FORMAT is read as
    // `field::value` pairs, exactly as it would be with no DEST_KEY present.
    destKeyDir: phase === 'index-time' ? effectiveDirective(directives, 'DEST_KEY') : undefined,
    writeMeta: flag('WRITE_META'),
    repeatMatch,
    // REPEAT_MATCH is documented as index-time only, and there it is the
    // switch: without it the REGEX runs once. At search time it is inert, yet
    // Splunk still extracts every match — the report-repeat-match and
    // report-transform-search-time captures (10.4.0) both show repeated
    // extraction, the first with REPEAT_MATCH set but irrelevant and the second
    // without it — and MV_ADD alone decides whether the later values are kept.
    scanAll: phase === 'search-time' || repeatMatch,
    mvAdd: phase === 'search-time' && flag('MV_ADD'),
  };
}

/**
 * The text an index-time REGEX searches. LOOKAHEAD bounds how far into the
 * source it looks; the bound exists even when the attribute is absent
 * (Splunk's default is 4096 characters). It is an index-time attribute, so
 * search-time extractions scan the whole source. A non-positive or
 * unparseable value falls back to the default rather than to "no limit".
 */
function applyLookahead(sourceValue: string, transformStanza: ConfStanza, phase: Phase): string {
  if (phase !== 'index-time') return sourceValue;
  const lookaheadRaw = effectiveDirective(transformStanza.directives, 'LOOKAHEAD')?.value.trim();
  const parsedLookahead = lookaheadRaw !== undefined ? parseInt(lookaheadRaw, 10) : NaN;
  const lookahead = Number.isFinite(parsedLookahead) && parsedLookahead > 0 ? parsedLookahead : 4096;
  return sourceValue.length > lookahead ? sourceValue.slice(0, lookahead) : sourceValue;
}

/** The result of a REGEX that did not match: DEFAULT_VALUE, or why nothing happened. */
function noMatchResult(
  transformStanza: ConfStanza,
  settings: RegexSettings,
  compiled: SplunkRegex,
  pattern: string,
  sourceValue: string,
  phase: Phase,
  mayExplain: () => boolean,
): TransformResult {
  const result: TransformResult = { fields: {}, matched: false };
  // DEFAULT_VALUE: an index-time transform whose REGEX fails writes this value
  // to DEST_KEY instead of doing nothing, so the destination is written for
  // every event. `matched` doubles as "has an effect to route" for the caller.
  const defaultValue =
    phase === 'index-time' ? effectiveDirective(transformStanza.directives, 'DEFAULT_VALUE')?.value.trim() : undefined;
  const destKeyForDefault = settings.destKeyDir?.value.trim();
  if (defaultValue !== undefined && defaultValue !== '' && destKeyForDefault) {
    return { ...result, matched: true, destKey: destKeyForDefault, destValue: defaultValue };
  }
  // An empty SOURCE_KEY is reported ahead of the pattern: a working regex
  // against nothing is not a regex problem, and saying it did not match sends
  // the reader to rewrite something that is already correct.
  if (sourceValue === '') {
    return { ...result, noOp: { kind: 'source-key-empty', sourceKey: settings.sourceKeyDir?.value.trim() ?? '_raw' } };
  }
  if (compiled.lastError !== undefined) {
    return { ...result, noOp: { kind: 'regex-limit', error: compiled.lastError } };
  }
  result.noOp = explainNoMatch(pattern, sourceValue, mayExplain());
  return result;
}

/** A REGEX that matched: everything the output steps below read. */
interface MatchedRun {
  result: TransformResult;
  compiled: SplunkRegex;
  firstMatch: RegexMatch;
  sourceValue: string;
  settings: RegexSettings;
  cleanName: (raw: string) => string;
  phase: Phase;
}

/**
 * Write FORMAT's expansion to DEST_KEY.
 *
 * DEST_KEY=_raw replaces the ENTIRE event with the FORMAT expansion of the
 * first match — it is NOT a sed-style substitution. Anything the regex does
 * not capture and FORMAT does not reproduce is discarded. (SEDCMD is the
 * tool for substituting in place while keeping the rest of the event.)
 */
function writeDestKey(run: MatchedRun, format: string, destKey: string, priorDestValue: string | undefined): void {
  const { result, firstMatch } = run;
  // normaliseDestKey folds the _MetaData:X alias, so both forms look up alike.
  if (destKey === '_raw' || SINGLE_VALUE_DEST_KEYS.has(normaliseDestKey(destKey))) {
    // Single-valued slot: FORMAT applies to the first match only.
    result.destKey = destKey;
    result.destValue = expandFormat(format, firstMatch, priorDestValue);
    return;
  }
  // DEST_KEY=<field> or _meta: one value per match, accumulated as a
  // multi-value field or a run of `key::value` pairs — under REPEAT_MATCH
  // only, since without it the REGEX runs once.
  const matches = run.settings.repeatMatch ? run.compiled.matchAll(run.sourceValue) : [firstMatch];
  const values = matches.map((m) => expandFormat(format, m, priorDestValue));
  if (values.length > 0) {
    result.destKey = destKey;
    result.destValue = values.join('\n');
  }
}

/**
 * No DEST_KEY: FORMAT is "field1::$1 field2::$2". The pair structure is
 * parsed from the FORMAT *before* captures are substituted, then each
 * half is expanded on its own — Splunk tokenizes FORMAT at config time and
 * substitutes afterwards. Expanding first would let a captured value's own
 * spaces end the value early, and let a captured `::` synthesize a field.
 * `$0` means "what was in the DEST_KEY before the REGEX ran", and this
 * branch is the one with no DEST_KEY — so the reference names nothing and
 * Splunk creates no field for the pair at all; showing one would be a field
 * that cannot exist in the real deployment.
 */
function extractFormatPairs(run: MatchedRun, format: string): void {
  const { result, settings, cleanName } = run;
  const pairs = parseFormatPairs(format).filter((p) => !/\$0(?!\d)/.test(p.key) && !/\$0(?!\d)/.test(p.value));
  const keepFirstMatchOnly = run.phase === 'search-time' && !settings.mvAdd;
  // Index time without REPEAT_MATCH: the REGEX runs once.
  for (const m of settings.scanAll ? run.compiled.matchAll(run.sourceValue) : [run.firstMatch]) {
    for (const pair of pairs) {
      // Cleaned because FORMAT can name a field from the DATA (`$1::$2`), so
      // the key is only as well-formed as whatever the capture group caught.
      const field = cleanName(expandFormat(pair.key, m));
      if (!field) continue;
      // MV_ADD governs this path too, not just the named-capture-group one:
      // at its default of false Splunk keeps the first match and discards
      // the rest rather than building a multivalue field. It is a
      // search-time attribute, so an index-time transform still accumulates
      // (when REPEAT_MATCH gives it more than one match to accumulate) --
      // gating both phases on it would make MV_ADD do something where
      // Splunk ignores it entirely.
      if (keepFirstMatchOnly && hasField(result.fields, field)) continue;
      addMultiValue(result.fields, field, expandFormat(pair.value, m));
    }
  }
}

/**
 * No FORMAT — extract named capture groups, scanning the same matches the
 * FORMAT path does (`scanAll`): every match at search time, and at index
 * time only under REPEAT_MATCH. When a field is captured more than once,
 * MV_ADD=true accumulates a multivalue field while MV_ADD=false keeps the
 * first value and discards the rest — the same rule as a FORMAT stanza.
 */
function extractNamedGroups(run: MatchedRun): void {
  const { result, settings, cleanName } = run;
  const matches = settings.scanAll ? run.compiled.matchAll(run.sourceValue) : [run.firstMatch];

  // Whether a field captured again by a later match keeps the later value.
  // The same rule as `keepFirstMatchOnly` in the FORMAT path, stated the other
  // way round: at search time MV_ADD decides; at index time MV_ADD is inert,
  // and REPEAT_MATCH — the only way there is more than one match to see —
  // "runs the REGEX multiple times", each match writing the field, as the
  // FORMAT path accumulates every match.
  const accumulate = run.phase === 'index-time' || settings.mvAdd;

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
      // strip at index time, so `user-name=bob` gives `user_name`, as in Splunk.
      assignField(cleanName(keyText), valText);
    }

    // Remaining named groups become fields verbatim (skip the _KEY_/_VAL_ pair
    // groups, which are extraction machinery rather than real field names).
    for (const [name, value] of Object.entries(groups)) {
      if (value === undefined) continue;
      if (/^_(?:KEY|VAL)_/.test(name)) continue;
      assignField(settings.writeMeta ? stripLeadingUnderscoreForField(name) : name, value);
    }
  }
}

/**
 * The FORMAT in force. Index-time FORMAT defaults to `<stanza-name>::$1` when
 * omitted (transforms.conf.spec). Named capture groups auto-extract without a
 * FORMAT, so the default only applies to a REGEX that uses numbered groups (at
 * least group 1 must exist to reference).
 *
 * The search-time default is empty: a REPORT- with only numbered groups
 * and no FORMAT extracts nothing, rather than inventing a field named after the
 * stanza. Named groups still extract there — the
 * report-named-groups-without-format capture (10.4.0) pins that.
 */
function resolveFormat(transformStanza: ConfStanza, run: MatchedRun): string | undefined {
  const hasNamedGroups = run.firstMatch.groups !== undefined;
  return (
    run.settings.formatDir?.value.trim() ??
    (run.phase === 'index-time' && !hasNamedGroups && run.firstMatch.length > 1
      ? `${transformStanza.name}::$1`
      : undefined)
  );
}

export function applyRegexTransform(
  event: SplunkEvent,
  transformStanza: ConfStanza,
  onInvalidRegex?: (pattern: string) => void,
  phase: Phase = 'index-time',
  /**
   * Whether a REGEX that did not match is analysed for how far it got. Asked
   * only when it did not match, so the caller can count analyses against the
   * run's per-directive cap.
   */
  mayExplain: () => boolean = () => true,
): TransformResult {
  const settings = readRegexSettings(transformStanza, phase);
  const { regexDir, sourceKeyDir } = settings;
  const cleanName = keyCleaner(transformStanza, settings.writeMeta, phase);

  // DELIMS-based (delimiter) extraction is used in place of REGEX — and is
  // search-time only, so an index-time reference to a DELIMS stanza extracts
  // nothing at all. Falling through to the REGEX branch is correct: a DELIMS
  // stanza has no REGEX, so the transform does nothing.
  const delimsDir = phase === 'search-time' ? effectiveDirective(transformStanza.directives, 'DELIMS') : undefined;
  if (delimsDir) {
    return applyDelimsExtraction(resolveSourceValue(event, sourceKeyDir), transformStanza, delimsDir, cleanName);
  }

  if (!regexDir) return { fields: {}, matched: false };

  const sourceValue = applyLookahead(resolveSourceValue(event, sourceKeyDir), transformStanza, phase);
  const pattern = regexDir.value.trim();
  const compiled = getCompiledRegex(transformStanza, pattern);
  if (!compiled) {
    // The transform silently does nothing, so let the caller surface a diagnostic.
    onInvalidRegex?.(pattern);
    return {
      fields: {},
      matched: false,
      noOp: { kind: 'regex-invalid', error: validateRegex(pattern) ?? 'invalid regex' },
    };
  }

  // The first match decides named vs numbered handling and is the only match
  // for non-REPEAT_MATCH extraction.
  const firstMatch = compiled.exec(sourceValue);
  if (!firstMatch) return noMatchResult(transformStanza, settings, compiled, pattern, sourceValue, phase, mayExplain);

  const run: MatchedRun = {
    result: { fields: {}, matched: true },
    compiled,
    firstMatch,
    sourceValue,
    settings,
    cleanName,
    phase,
  };
  const format = resolveFormat(transformStanza, run);
  const destKey = settings.destKeyDir?.value.trim();
  if (!format) extractNamedGroups(run);
  else if (destKey) writeDestKey(run, format, destKey, resolvePriorDestValue(event, destKey));
  else extractFormatPairs(run, format);
  return run.result;
}
