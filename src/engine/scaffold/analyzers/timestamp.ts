import { AUTO_TIME_FORMATS, execAutoFormat } from '../../processors/timestampExtractor';
import { strftimeToRegex } from '../../../utils/strftime';
import { escapeRegex } from '../../../utils/splunkRegex';
import type { Confidence, ScaffoldSuggestion } from '../types';

// Reuse the engine's priority-ordered recognition table (single source of truth).
const PATTERNS = AUTO_TIME_FORMATS.map((fmt) => ({ fmt, regex: strftimeToRegex(fmt) }));

const SAMPLE_SIZE = 20;

export function detectTimestamp(lines: string[]): ScaffoldSuggestion[] {
  const sample = lines.filter((l) => l.trim().length > 0).slice(0, SAMPLE_SIZE);
  if (sample.length === 0) return [];

  // Leading epoch → TIME_FORMAT. A 13-digit value is milliseconds: real Splunk's
  // %s reads only whole seconds, so a bare %s misparses it — it needs %s%3N.
  const epochMatches = sample
    .map((l) => /^\s*\d{10}(\d{3})?(?!\d)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  if (epochMatches.length / sample.length >= 0.8) {
    const millis = epochMatches.filter((m) => m[1] !== undefined).length;
    const isMillis = millis >= epochMatches.length / 2;
    const conf: Confidence = epochMatches.length === sample.length ? 'high' : 'medium';
    return [{
      key: 'TIME_FORMAT',
      value: isMillis ? '%s%3N' : '%s',
      confidence: conf,
      evidence: `${epochMatches.length}/${sample.length} lines start with ${isMillis ? 'a millisecond ' : 'an '}epoch timestamp`,
      enabledByDefault: true,
    }];
  }

  // Tally the highest-priority format that matches each line.
  const tally = new Map<string, { count: number; match: RegExpExecArray; line: string }>();
  for (const line of sample) {
    for (const { fmt, regex } of PATTERNS) {
      const m = execAutoFormat(fmt, regex, line);
      if (!m) continue;
      const e = tally.get(fmt);
      if (e) e.count++;
      else tally.set(fmt, { count: 1, match: m, line });
      break;
    }
  }
  if (tally.size === 0) return [];

  let bestFmt = '';
  let best: { count: number; match: RegExpExecArray; line: string } | null = null;
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
    { key: 'TIME_FORMAT', value: bestFmt, confidence, evidence: `Matched in ${best.count}/${sample.length} sample lines`, enabledByDefault: true },
  ];

  const matchEnd = best.match.index + best.match[0].length;
  const tsLen = best.match[0].length;
  const prefix = derivePrefix(best.line.slice(0, best.match.index));

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
  const kv = /(["']?[\w.-]+["']?\s*[:=]\s*["']?)$/.exec(before);
  if (kv) return kv[1] ?? '';
  // Otherwise a short trailing punctuation delimiter (e.g. "[").
  const punct = /([^\w\s]{1,4})$/.exec(before);
  if (punct) return punct[1] ?? '';
  return '';
}
