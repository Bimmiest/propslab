// Key cleaning: how a transform rewrites the names of the fields it extracts —
// CLEAN_KEYS at search time, the WRITE_META underscore strip at index time.

import type { ConfStanza } from '../types';
import { stripLeadingUnderscoreForField } from '../utils/internalFields';
import { effectiveDirective, parseSplunkBool } from '../utils/directiveValues';

/**
 * CLEAN_KEYS "key cleaning": replace every non-alphanumeric character with an
 * underscore, then strip leading underscores and digits.
 *
 * Both halves are transforms.conf.spec's description of CLEAN_KEYS:
 * `9.x-y` → `9_x_y` → `x_y`.
 *
 * Interior underscores survive — only a LEADING run is stripped — which is why
 * a FIELDS name like `col_a` comes back unchanged.
 */
export function cleanFieldKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '_').replace(/^[_0-9]+/, '');
}

/**
 * Resolve the field-name transformation a transform applies to keys it extracts.
 *
 * CLEAN_KEYS is search-time only, and defaults to on. At index time the only
 * name rewriting is the leading-underscore strip that WRITE_META performs.
 */
export function keyCleaner(
  stanza: ConfStanza,
  writeMeta: boolean,
  phase: 'index-time' | 'search-time',
): (raw: string) => string {
  if (phase === 'index-time') {
    return (raw) => (writeMeta ? stripLeadingUnderscoreForField(raw.trim()) : raw.trim());
  }
  // Splunk reads this as a boolean, so a false spelling turns cleaning off and
  // anything else (including an absent directive) leaves it on.
  const cleanKeys = parseSplunkBool(effectiveDirective(stanza.directives, 'CLEAN_KEYS')?.value, true);
  return (raw) => (cleanKeys ? cleanFieldKey(raw.trim()) : raw.trim());
}
