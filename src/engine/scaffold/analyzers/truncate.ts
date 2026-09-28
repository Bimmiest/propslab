import type { ScaffoldSuggestion } from '../types';

const DEFAULT_TRUNCATE = 10000;

/**
 * Suggest raising TRUNCATE only when events are long enough that the 10000-byte
 * default would cut them. Suggesting a *lower* value would risk truncating valid
 * events, so the default is left alone for short data. `segments` are the
 * LINE_BREAKER segments the stanza will produce, which is what TRUNCATE caps.
 */
export function detectTruncate(segments: string[]): ScaffoldSuggestion[] {
  const lengths = segments.map((l) => l.length).filter((n) => n > 0).sort((a, b) => a - b);
  if (lengths.length === 0) return [];

  const p99 = percentile(lengths, 0.99);
  const maxLen = lengths.at(-1) ?? 0;
  // Clamp the p99-based headroom up to at least the longest event, rounded to
  // the next 1000. Otherwise a long tail (e.g. one 50000-char event among 8000-
  // char ones) yields a suggestion BELOW maxLen that would truncate real events —
  // the exact outcome the evidence text ("Longest events ≈ maxLen") promises to avoid.
  const p99Headroom = Math.ceil((p99 * 1.5) / 1000) * 1000;
  const maxHeadroom = Math.ceil(maxLen / 1000) * 1000;
  const headroom = Math.max(p99Headroom, maxHeadroom);
  if (headroom <= DEFAULT_TRUNCATE) return [];

  return [{
    key: 'TRUNCATE',
    value: String(headroom),
    confidence: 'medium',
    evidence: `Longest events ≈ ${maxLen} chars — raise TRUNCATE above the ${DEFAULT_TRUNCATE} default`,
    enabledByDefault: true,
  }];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}
