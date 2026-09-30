import type { EventMetadata } from '../types';
import type { ScaffoldResult, ScaffoldSuggestion } from './types';
import { detectLineFormat } from './analyzers/lineFormat';
import { detectTimestamp } from './analyzers/timestamp';
import { detectTruncate } from './analyzers/truncate';
import { detectSourcetypeHygiene } from './analyzers/sourcetype';
import { splitSegments } from '../processors/lineBreaker';

/**
 * Inspect raw sample data + metadata and propose a starter props.conf stanza.
 * Pure and deterministic — the UI renders the result as a diff the user applies.
 */
export function scaffoldConfig(rawData: string, metadata: EventMetadata): ScaffoldResult {
  const lines = rawData.split(/\r?\n/);

  // TRUNCATE caps each LINE_BREAKER segment, so size against the segments the
  // proposed breaker yields: one that keeps a pretty-printed object whole makes
  // the whole object one line to truncate.
  const format = detectLineFormat(rawData, lines);
  const breaker = format.find((s) => s.key === 'LINE_BREAKER')?.value;
  const segments = breaker ? splitSegments(rawData, breaker, []).map((s) => s.text) : lines;

  // Timestamp first so TIME_* directives lead the stanza, then format, then sizing.
  let suggestions: ScaffoldSuggestion[] = [...detectTimestamp(lines), ...format, ...detectTruncate(segments)];

  // Never propose INDEXED_EXTRACTIONS and KV_MODE together: applying both
  // double-extracts and duplicates field values. When a delimited (index-time)
  // extraction is detected it wins; otherwise KV_MODE (search-time) stands.
  if (suggestions.some((s) => s.key === 'INDEXED_EXTRACTIONS')) {
    suggestions = suggestions.filter((s) => s.key !== 'KV_MODE');
  }

  const sourcetypeSuggestion = detectSourcetypeHygiene(metadata.sourcetype) ?? undefined;
  const sourcetype = sourcetypeSuggestion?.value || metadata.sourcetype.trim() || 'my:sourcetype';

  return { sourcetype, sourcetypeSuggestion, suggestions };
}
