import { recognizeTimestamp, type RecognizedTimestamp } from '../../processors/timestampRecognizer';
import { escapeRegex } from '../../../utils/splunkRegex';
import type { Confidence, ScaffoldSuggestion } from '../types';

const SAMPLE_SIZE = 20;

export function detectTimestamp(lines: string[]): ScaffoldSuggestion[] {
  const sample = lines.filter((l) => l.trim().length > 0).slice(0, SAMPLE_SIZE);
  if (sample.length === 0) return [];

  // Tally the format automatic recognition reads from each line, so the
  // suggested TIME_FORMAT is one extraction itself would have used. The whole
  // line is searched: the suggested lookahead is derived from where it is found.
  // A 13-digit epoch comes back as %s%3N, which real Splunk needs -- its %s
  // reads only whole seconds.
  const tally = new Map<string, { count: number; match: RecognizedTimestamp; line: string }>();
  for (const line of sample) {
    const m = recognizeTimestamp(line);
    if (!m) continue;
    const e = tally.get(m.format);
    if (e) e.count++;
    else tally.set(m.format, { count: 1, match: m, line });
  }

  let bestFmt = '';
  let best: { count: number; match: RecognizedTimestamp; line: string } | null = null;
  for (const [fmt, e] of tally) {
    if (!best || e.count > best.count) {
      bestFmt = fmt;
      best = e;
    }
  }
  if (!best) return [];

  const ratio = best.count / sample.length;
  const confidence: Confidence = ratio >= 0.9 ? 'high' : ratio >= 0.5 ? 'medium' : 'low';
  const out: ScaffoldSuggestion[] = [
    {
      key: 'TIME_FORMAT',
      value: bestFmt,
      confidence,
      evidence: `Matched in ${best.count}/${sample.length} sample lines`,
      enabledByDefault: true,
    },
  ];

  const matchEnd = best.match.end;
  const tsLen = best.match.end - best.match.start;
  const prefix = derivePrefix(best.line.slice(0, best.match.start));

  if (prefix) {
    out.push({
      key: 'TIME_PREFIX',
      value: escapeRegex(prefix),
      confidence: 'medium',
      evidence: `Timestamp follows the literal "${prefix}"`,
      enabledByDefault: true,
    });
    // MAX_TIMESTAMP_LOOKAHEAD is measured from AFTER the TIME_PREFIX match, so cap
    // it to the timestamp length — Splunk stops scanning once the timestamp is read.
    // Splunk recommends this as an indexing-performance best practice.
    out.push({
      key: 'MAX_TIMESTAMP_LOOKAHEAD',
      value: String(tsLen + 1),
      confidence: 'medium',
      evidence: `Timestamp is ${tsLen} characters; cap the search just past TIME_PREFIX for indexing performance`,
      enabledByDefault: true,
    });
  } else {
    // No prefix → lookahead counts from the start of the event. Cap it near the
    // timestamp's end so Splunk doesn't scan the whole 128-character default window.
    out.push({
      key: 'MAX_TIMESTAMP_LOOKAHEAD',
      value: String(matchEnd + 10),
      confidence,
      evidence: `Timestamp ends near character ${matchEnd}; cap the search there for indexing performance`,
      enabledByDefault: true,
    });
  }

  return out;
}

/**
 * Derive a STABLE TIME_PREFIX from the text preceding the timestamp — the
 * surrounding key/delimiter, never the per-event field values (which would only
 * match the one sample event). Returns '' when there is no useful prefix.
 */
export function derivePrefix(before: string): string {
  if (!before) return '';
  // Trailing `"key":` / key= boundary (JSON or key=value), incl. the value's opening quote.
  const kv = trailingKeyBoundary(before);
  if (kv) return kv;
  // Otherwise a short trailing punctuation delimiter (e.g. "[").
  const punct = /([^\w\s]{1,4})$/.exec(before);
  if (punct) return punct[1] ?? '';
  return '';
}

const isQuote = (c: string | undefined) => c === '"' || c === "'";
const isKeyChar = (c: string | undefined) => c !== undefined && /[\w.-]/.test(c);
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * The longest suffix of `s` matching `["']?[\w.-]+["']?\s*[:=]\s*["']?`, or ''.
 * Scanned backwards because the anchored regex retries from every start
 * position, which is quadratic on a long run of word characters -- and this
 * runs on every keystroke in the extract-name dialog. Every part of the
 * pattern is either greedy-unambiguous or optional with a disjoint class, so
 * taking each part maximally from the right yields the regex's (leftmost,
 * hence longest) match.
 */
function trailingKeyBoundary(s: string): string {
  let i = s.length;
  if (isQuote(s[i - 1])) i--;
  while (isSpace(s[i - 1])) i--;
  if (s[i - 1] !== ':' && s[i - 1] !== '=') return '';
  i--;
  while (isSpace(s[i - 1])) i--;
  if (isQuote(s[i - 1])) i--;
  const keyEnd = i;
  while (isKeyChar(s[i - 1])) i--;
  if (i === keyEnd) return '';
  if (isQuote(s[i - 1])) i--;
  return s.slice(i);
}
