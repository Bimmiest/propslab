// DELIMS/FIELDS: the delimiter-based search-time extraction a transform uses
// in place of REGEX, and the quoted-list syntax both attributes are written in.

import type { ConfDirective, ConfStanza } from '../types';
import type { TransformResult } from './regexTransform';
import { addFieldValue } from '../utils/fieldBag';
import { effectiveDirective } from '../utils/directiveValues';

/** Decode the escape sequences Splunk allows inside DELIMS/FIELDS quoted tokens. */
function decodeDelimEscapes(s: string): string {
  return s.replace(/\\([tnr"\\])/g, (_: string, c: string) =>
    c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : c,
  );
}

/**
 * Parse a comma-separated list of double-quoted tokens — used for both DELIMS
 * (each token is a set of delimiter characters) and FIELDS (each token is a
 * field name). Falls back to an unquoted comma-split for leniency.
 */
function parseDelimList(raw: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(decodeDelimEscapes(m[1] ?? ''));
  if (out.length === 0) {
    for (const part of raw.split(',')) {
      const t = part.trim();
      if (t) out.push(decodeDelimEscapes(t));
    }
  }
  return out;
}

/** Split on ANY single character in `delims` — each character is its own delimiter. */
function splitOnAnyChar(value: string, delims: string): string[] {
  if (!delims) return [value];
  const set = new Set(delims);
  const parts: string[] = [];
  let cur = '';
  for (const ch of value) {
    if (set.has(ch)) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * DELIMS/FIELDS delimiter-based extraction (the alternative to REGEX).
 *  - Two DELIMS sets → field/value pairs: first set splits pairs, second splits
 *    key from value (on the first key-delimiter occurrence).
 *  - One DELIMS set + FIELDS → positional values named by FIELDS.
 * Keys/values are trimmed; empty values are dropped (KEEP_EMPTY_VALS default false).
 * `sourceValue` is the SOURCE_KEY value, resolved by the caller as for REGEX.
 */
export function applyDelimsExtraction(
  sourceValue: string,
  stanza: ConfStanza,
  delimsDir: ConfDirective,
  cleanName: (raw: string) => string,
): TransformResult {
  const result: TransformResult = { fields: {}, matched: false };
  if (!sourceValue) return result;

  const delimSets = parseDelimList(delimsDir.value);
  if (delimSets.length === 0) return result;

  if (delimSets.length >= 2) {
    const [pairDelims = '', kvDelims = ''] = delimSets;
    const kvDelimSet = new Set(kvDelims);
    for (const pair of splitOnAnyChar(sourceValue, pairDelims)) {
      let splitAt = -1;
      for (let i = 0; i < pair.length; i++) {
        if (kvDelimSet.has(pair.charAt(i))) {
          splitAt = i;
          break;
        }
      }
      if (splitAt < 0) continue;
      const key = cleanName(pair.slice(0, splitAt));
      const value = pair.slice(splitAt + 1).trim();
      if (!key || !value) continue;
      addFieldValue(result.fields, key, value);
    }
  } else {
    const fieldsDir = effectiveDirective(stanza.directives, 'FIELDS');
    if (!fieldsDir) return result;
    const names = parseDelimList(fieldsDir.value);
    const values = splitOnAnyChar(sourceValue, delimSets[0] ?? '');
    for (let i = 0; i < names.length && i < values.length; i++) {
      const key = cleanName(names[i] ?? '');
      const value = (values[i] ?? '').trim();
      if (!key || !value) continue;
      addFieldValue(result.fields, key, value);
    }
  }

  result.matched = Object.keys(result.fields).length > 0;
  return result;
}
