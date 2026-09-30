import { escapeRegex } from '../../utils/splunkRegex';
import { derivePrefix } from './analyzers/timestamp';

export interface GeneratedDirective {
  key: string;
  value: string;
}

/**
 * Turn a literal selection into a regex fragment ("regex by example"): all-digits
 * → \d+, dotted-quad IP → an IP pattern, UUID-ish → hex/dash, a single word → \w+,
 * otherwise a non-space run. Conservative on purpose — the user edits from here.
 *
 * `quoted` narrows the catch-all when the selection sits inside a quoted JSON
 * value. A bare `\S+` runs past the closing quote — selecting `x@y.com` in
 * `{"email":"x@y.com"}` captured `x@y.com"}` — so exclude the delimiters that
 * end such a value rather than stopping only at whitespace.
 */
export function generalize(text: string, quoted = false): string {
  if (/^\d+$/.test(text)) return '\\d+';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return '\\d+\\.\\d+\\.\\d+\\.\\d+';
  if (/-/.test(text) && /^[0-9a-fA-F-]{8,}$/.test(text)) return '[0-9a-fA-F-]+';
  if (/^\w+$/.test(text)) return '\\w+';
  return quoted ? '[^"]+' : '\\S+';
}

/**
 * Sanitise a field name into a valid regex capture-group identifier
 * (`[A-Za-z_][A-Za-z0-9_]*`). Splunk field names routinely contain hyphens,
 * dots, or a leading digit — all illegal in a `(?<name>…)` group — so we replace
 * illegal characters with `_` and prefix a leading digit. Without this the
 * generated regex fails to compile and the dialog blames "invalid regex".
 */
export function toCaptureGroupName(fieldName: string): string {
  const cleaned = fieldName.trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!cleaned) return 'field';
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Build an `EXTRACT-<field>` directive that captures `selectedText` within `raw`,
 * anchored on the stable literal that precedes it (a key/delimiter boundary, via
 * derivePrefix) so the regex isn't position-dependent. Returns null for empty input.
 *
 * `selectionStart`, when provided, is the real offset of the selection in `raw`;
 * it is used instead of `indexOf` so a value that also occurs earlier in the event
 * (e.g. selecting the second `200` in `status=200 code=200`) anchors on the
 * occurrence the user actually picked.
 */
export function buildExtractFromSelection(
  raw: string,
  selectedText: string,
  fieldName: string,
  selectionStart?: number,
): GeneratedDirective | null {
  if (!selectedText) return null;
  const name = toCaptureGroupName(fieldName);
  const idx = selectionStart !== undefined && selectionStart >= 0 ? selectionStart : raw.indexOf(selectedText);
  const before = idx > 0 ? raw.slice(0, idx) : '';
  const prefixLiteral = before ? derivePrefix(before) : '';
  const prefix = prefixLiteral ? escapeRegex(prefixLiteral) : '';
  // A selection that both starts right after a quote and ends right before one
  // is a quoted value, so the capture must stop at the closing quote.
  const quoted = raw[idx - 1] === '"' && raw[idx + selectedText.length] === '"';
  return { key: `EXTRACT-${name}`, value: `${prefix}(?<${name}>${generalize(selectedText, quoted)})` };
}

/**
 * Derive a TIME_PREFIX (escaped) from the stable literal immediately preceding the
 * selected timestamp. Returns null when there is no usable preceding boundary.
 * `selectionStart` (the real offset in `raw`) is preferred over `indexOf`.
 */
export function timePrefixFromSelection(raw: string, selectedText: string, selectionStart?: number): string | null {
  const idx = selectionStart !== undefined && selectionStart >= 0 ? selectionStart : raw.indexOf(selectedText);
  if (idx <= 0) return null;
  const literal = derivePrefix(raw.slice(0, idx));
  return literal ? escapeRegex(literal) : null;
}
