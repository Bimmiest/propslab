// ---------------------------------------------------------------------------
// directiveLint.ts
// Config mistakes Splunk itself says nothing about.
//
// Two rules live here, and they share a shape: the config loads clean, the
// search runs, and the setting does nothing. Splunk gives no feedback at all,
// so short of reading the .spec line by line there is no way for a user to
// discover either. That is squarely in this tool's remit — the whole claim is
// "this is what Splunk will do", and showing a setting working when a real
// deployment would ignore it is the failure that matters most.
//
//   1. A transforms setting used in the phase where it is inert (#177).
//   2. A value that is not the type the directive documents (#179).
// ---------------------------------------------------------------------------

import type { ConfStanza, ValidationDiagnostic } from './types';
import { atDirective } from './parser/provenance';
import { getDirectiveInfo } from './directiveRegistry';
import { effectiveDirective, isSplunkBoolLiteral } from './utils/directiveValues';

/**
 * transforms.conf settings that do nothing in one of the two phases. A stanza's
 * phase is decided by how props.conf reaches it: `TRANSFORMS-` is index-time and
 * `REPORT-` is search-time.
 *
 * From transforms.conf.spec (Splunk 10.4.0), which states the restriction on
 * each setting individually rather than in one table.
 */
const INERT_AT_INDEX_TIME: Record<string, string> = {
  MV_ADD: 'it only affects search-time field extractions',
  CLEAN_KEYS: 'key cleaning only applies to search-time field extractions',
  KEEP_EMPTY_VALS: 'it only affects search-time field extractions',
  DELIMS: 'delimiter-based extraction is search-time only',
  FIELDS: 'it names the fields for a DELIMS extraction, which is search-time only',
  CAN_OPTIMIZE: 'it governs the search-time optimiser',
};

const INERT_AT_SEARCH_TIME: Record<string, string> = {
  DEST_KEY: 'writing to a key other than a field is index-time only',
  REPEAT_MATCH: 'it only applies to index-time transforms',
  INGEST_EVAL: 'ingest-time eval runs during indexing',
  DEFAULT_VALUE: 'it only applies to index-time transforms',
  LOOKAHEAD: 'the regex search window only applies to index-time transforms',
  STOP_PROCESSING_IF: 'it only applies to index-time transforms',
};

/**
 * Report transforms settings that are inert for the phase their stanza is used
 * in. `phaseByStanza` maps a transforms stanza name to how props.conf reaches
 * it; a stanza referenced from both is skipped, since every setting is live in
 * one of the two and flagging it would be wrong half the time.
 */
export function lintInertTransformSettings(
  transformsStanzas: ConfStanza[],
  phaseByStanza: Map<string, 'index-time' | 'search-time' | 'both'>,
  diagnostics: ValidationDiagnostic[],
): void {
  for (const stanza of transformsStanzas) {
    const phase = phaseByStanza.get(stanza.name);
    if (phase === undefined || phase === 'both') continue;

    const inert = phase === 'index-time' ? INERT_AT_INDEX_TIME : INERT_AT_SEARCH_TIME;
    const reference = phase === 'index-time' ? 'TRANSFORMS-' : 'REPORT-';

    for (const dir of stanza.directives) {
      const reason = inert[dir.key];
      if (!reason) continue;
      diagnostics.push({
        level: 'warning',
        message:
          `${dir.key} does nothing here: this stanza is reached from props.conf through ` +
          `${reference}, which makes it ${phase}, and ${reason}. Splunk loads this config ` +
          'without complaint and silently ignores the setting.',
        file: 'transforms.conf',
        ...atDirective(dir),
        directiveKey: dir.key,
      });
    }
  }

  // `REPEAT_MATCH` has a second, narrower restriction the spec states outright:
  // it is ignored when DEST_KEY is _raw. Checked separately because it depends
  // on a sibling directive rather than on the stanza's phase.
  for (const stanza of transformsStanzas) {
    const destKey = effectiveDirective(stanza.directives, 'DEST_KEY');
    if (destKey?.value.trim() !== '_raw') continue;
    const repeat = effectiveDirective(stanza.directives, 'REPEAT_MATCH');
    if (!repeat) continue;
    diagnostics.push({
      level: 'warning',
      message:
        'REPEAT_MATCH is ignored when DEST_KEY = _raw, because the whole event is replaced by the ' +
        'first match rather than accumulated across matches.',
      file: 'transforms.conf',
      ...atDirective(repeat),
      directiveKey: repeat.key,
    });
  }
}

/**
 * Report values that are not the type their directive documents.
 *
 * Deliberately conservative. The registry's metadata is hand-maintained (#178
 * tracks generating it), the fidelity work has already shown Splunk to be
 * fussier than its own documentation in places, and a false positive on correct
 * config is worse here than a missed one: a user who is told their working
 * config is wrong stops trusting every other diagnostic. So this checks only
 * what cannot be argued with — a boolean that is not a boolean literal, a
 * number that is not a number, a negative where the spec says non-negative, and
 * an enum value outside the documented set.
 */
export function lintDirectiveValues(
  stanzas: ConfStanza[],
  file: 'props.conf' | 'transforms.conf',
  diagnostics: ValidationDiagnostic[],
): void {
  for (const stanza of stanzas) {
    for (const dir of stanza.directives) {
      // Class-based keys carry their class in the key, so look up the base.
      const info = getDirectiveInfo(dir.className ? dir.directiveType : dir.key, file);
      if (!info) continue;

      const value = dir.value.trim();
      // An empty value resets the setting to its default in Splunk rather than
      // being a type error.
      if (value === '') continue;

      const report = (message: string, suggestion?: string) => {
        diagnostics.push({
          level: 'warning',
          message,
          file,
          ...atDirective(dir),
          directiveKey: dir.key,
          ...(suggestion ? { suggestion } : {}),
        });
      };

      if (info.valueType === 'boolean' && !isSplunkBoolLiteral(value)) {
        report(
          `${dir.key} takes a boolean, and "${value}" is not one. Splunk reads an unrecognised ` +
            'value as false rather than reporting it.',
          'true',
        );
        continue;
      }

      if (info.valueType === 'number') {
        if (!/^[+-]?\d+$/.test(value)) {
          report(`${dir.key} takes an integer, and "${value}" is not one.`);
        } else if (value.startsWith('-') && NON_NEGATIVE.has(info.key) && NEGATIVE_SENTINELS[info.key] !== value) {
          report(
            `${dir.key} cannot be negative — "${value}" will not do what it looks like it does.`,
          );
        }
        continue;
      }

      if (info.valueType === 'enum' && info.enumValues) {
        // `multi:<stanza>` is the one enum member that carries an argument.
        const base = value.toLowerCase().split(':')[0] ?? '';
        const allowed = info.enumValues.map((v) => v.toLowerCase());
        if (!allowed.includes(value.toLowerCase()) && !allowed.includes(base)) {
          report(
            `${dir.key} does not accept "${value}". Splunk falls back to the default rather than ` +
              `reporting it. Valid values: ${info.enumValues.join(', ')}.`,
            info.enumValues[0],
          );
        }
      }
    }
  }
}

/**
 * Numeric directives the spec documents as non-negative. A negative here is not
 * merely odd — Splunk treats it as unset, so the setting silently does nothing.
 */
const NON_NEGATIVE = new Set([
  'TRUNCATE',
  'MAX_EVENTS',
  'MAX_TIMESTAMP_LOOKAHEAD',
  'MAX_DAYS_AGO',
  'MAX_DAYS_HENCE',
  'MAX_DIFF_SECS_AGO',
  'MAX_DIFF_SECS_HENCE',
  'MATCH_LIMIT',
  'DEPTH_LIMIT',
  'LINE_BREAKER_LOOKBEHIND',
  'HEADER_FIELD_LINE_NUMBER',
]);

/**
 * The one negative a non-negative directive documents as meaningful.
 * props.conf.spec: MAX_TIMESTAMP_LOOKAHEAD "0 or -1 disables the length
 * constraint", so flagging -1 told users a correct setting was broken (#286).
 */
const NEGATIVE_SENTINELS: Readonly<Record<string, string>> = {
  MAX_TIMESTAMP_LOOKAHEAD: '-1',
};
