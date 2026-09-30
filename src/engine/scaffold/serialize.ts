import type { ScaffoldSuggestion } from './types';
import { escapeRegex } from '../../utils/splunkRegex';
import { endsWithContinuation } from '../utils/directiveValues';

/**
 * Why a stanza name may not be written verbatim into a header.
 * Returns null when the name is usable.
 */
export function stanzaNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Stanza name cannot be empty.';
  if (/[[\]]/.test(trimmed)) {
    // `foo]bar` renders as `[foo]bar]`, which does not round-trip as one stanza:
    // the parser stops at the first `]`, so the written file would not say what
    // the UI showed.
    return 'Stanza name cannot contain "[" or "]" — the header would not parse as a single stanza.';
  }
  if (/[\r\n]/.test(trimmed)) return 'Stanza name cannot contain a line break.';
  return null;
}

/** Render a props.conf stanza from the selected directive suggestions. */
export function renderStanza(sourcetype: string, suggestions: ScaffoldSuggestion[]): string {
  const lines = [`[${sourcetype}]`];
  for (const s of suggestions) lines.push(`${s.key} = ${s.value}`);
  return lines.join('\n');
}

/** Append a stanza to existing props.conf text (or set it when the file is empty). */
export function appendStanza(existing: string, stanza: string): string {
  const trimmed = existing.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${stanza}\n` : `${stanza}\n`;
}

/** A physical line without its CR, so a CRLF file's trailing backslash still reads as a continuation. */
function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * For each physical line, whether it continues the directive before it. Mirrors
 * confParser: a directive line ending in an ODD number of backslashes swallows
 * the next line whatever it looks like (a header, a comment, a blank), and that
 * line continues in turn if it ends the same way. Comments, headers and blank
 * lines never start a continuation, so a trailing backslash on one is literal.
 */
function continuationFlags(lines: string[]): boolean[] {
  const continued: boolean[] = [];
  let open = false;
  for (const raw of lines) {
    const line = withoutCr(raw);
    continued.push(open);
    if (open) {
      open = endsWithContinuation(line);
    } else {
      const t = line.trim();
      open = t !== '' && !t.startsWith('#') && !t.startsWith('[') && endsWithContinuation(line);
    }
  }
  return continued;
}

/** Index of the last line in [from, to) that `re` matches and that is not a continuation line, or -1. */
function lastIndexMatching(lines: string[], continued: boolean[], re: RegExp, from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (!continued[i] && re.test(lines[i] ?? '')) return i;
  return -1;
}

/**
 * Insert or replace a `KEY = value` directive inside the named stanza of props.conf
 * text. If the stanza exists, the last definition of KEY in its last block is replaced
 * in place, together with any backslash-continued lines it spans; otherwise the directive is appended to the END of that block (after the last
 * directive, before any trailing blank line or the next stanza header). If the
 * stanza is absent, a new stanza is appended to the file.
 */
export function upsertDirectiveInStanza(propsText: string, stanzaName: string, key: string, value: string): string {
  const directiveLine = `${key} = ${value}`;
  const lines = propsText.split('\n');
  const headerRe = new RegExp(`^\\s*\\[${escapeRegex(stanzaName)}\\]\\s*$`);
  // A stanza may be split over several blocks, and a key over several lines;
  // the last definition wins, so that is the one to edit.
  const continued = continuationFlags(lines);
  const headerIdx = lastIndexMatching(lines, continued, headerRe, 0, lines.length);

  if (headerIdx === -1) {
    return appendStanza(propsText, `[${stanzaName}]\n${directiveLine}`);
  }

  // Extent of this stanza: up to the next stanza header (or end of file).
  let end = headerIdx + 1;
  while (end < lines.length && (continued[end] || !/^\s*\[.+\]\s*$/.test(lines[end] ?? ''))) end++;

  const keyRe = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const keyIdx = lastIndexMatching(lines, continued, keyRe, headerIdx + 1, end);
  if (keyIdx !== -1) {
    // The old definition spans its continuation lines too; replacing only the
    // first physical line would leave the rest behind as orphans.
    let spanEnd = keyIdx + 1;
    while (spanEnd < end && continued[spanEnd]) spanEnd++;
    const cr = (lines[keyIdx] ?? '').endsWith('\r') ? '\r' : '';
    lines.splice(keyIdx, spanEnd - keyIdx, directiveLine + cr);
  } else {
    // Append after the last non-blank line of the stanza, so it lands at the bottom
    // of the block rather than detached after a blank-line gap.
    let insertAt = end;
    // A blank line that ends a continuation belongs to that directive.
    while (insertAt > headerIdx + 1 && !continued[insertAt - 1] && (lines[insertAt - 1] ?? '').trim() === '') insertAt--;
    lines.splice(insertAt, 0, directiveLine);
  }
  return lines.join('\n');
}
