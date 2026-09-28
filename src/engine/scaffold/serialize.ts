import type { ScaffoldSuggestion } from './types';
import { escapeRegex } from '../../utils/splunkRegex';

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

/** Index of the last line in [from, to) that `re` matches, or -1. */
function lastIndexMatching(lines: string[], re: RegExp, from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (re.test(lines[i] ?? '')) return i;
  return -1;
}

/**
 * Insert or replace a `KEY = value` directive inside the named stanza of props.conf
 * text. If the stanza exists, the last line for KEY in its last block is replaced in
 * place; otherwise the directive is appended to the END of that block (after the last
 * directive, before any trailing blank line or the next stanza header). If the
 * stanza is absent, a new stanza is appended to the file.
 */
export function upsertDirectiveInStanza(propsText: string, stanzaName: string, key: string, value: string): string {
  const directiveLine = `${key} = ${value}`;
  const lines = propsText.split('\n');
  const headerRe = new RegExp(`^\\s*\\[${escapeRegex(stanzaName)}\\]\\s*$`);
  // A stanza may be split over several blocks, and a key over several lines;
  // the last definition wins, so that is the one to edit.
  const headerIdx = lastIndexMatching(lines, headerRe, 0, lines.length);

  if (headerIdx === -1) {
    return appendStanza(propsText, `[${stanzaName}]\n${directiveLine}`);
  }

  // Extent of this stanza: up to the next stanza header (or end of file).
  let end = headerIdx + 1;
  while (end < lines.length && !/^\s*\[.+\]\s*$/.test(lines[end] ?? '')) end++;

  const keyRe = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const keyIdx = lastIndexMatching(lines, keyRe, headerIdx + 1, end);
  if (keyIdx !== -1) {
    lines[keyIdx] = directiveLine;
  } else {
    // Append after the last non-blank line of the stanza, so it lands at the bottom
    // of the block rather than detached after a blank-line gap.
    let insertAt = end;
    while (insertAt > headerIdx + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt--;
    lines.splice(insertAt, 0, directiveLine);
  }
  return lines.join('\n');
}
