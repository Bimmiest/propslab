import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { atDirective } from '../parser/provenance';
import { segmentLengthsOf } from './lineBreaker';

// The engine type-checks against ES2022 alone (tsconfig.engine.json), so that
// reaching for a browser-only global fails the build instead of failing in a
// worker or under Node at run time (#280). The UTF-8 codecs are not ES but are
// safe to use: they are globals in browsers, Web Workers and every supported
// Node. Declared here, narrowed to what this file calls, rather than by pulling
// in a whole lib that would also admit DOMParser and friends.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean },
) => { decode(input: Uint8Array): string };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Return how many bytes of `bytes[0..maxBytes)` form a run of whole UTF-8
 * characters — i.e. `maxBytes` rounded down so it never lands in the middle of
 * a multi-byte sequence. Splunk rounds line-length truncation down to a
 * character boundary; a naive `slice(0, maxBytes)` + lenient decode would emit
 * a U+FFFD replacement character for the trailing partial sequence instead.
 */
function utf8BoundaryLength(bytes: Uint8Array, maxBytes: number): number {
  if (maxBytes >= bytes.length) return bytes.length;
  // Walk back over trailing continuation bytes (0b10xxxxxx) to the lead byte of
  // the character that straddles the cut.
  let i = maxBytes - 1;
  while (i >= 0 && ((bytes[i] ?? 0) & 0b1100_0000) === 0b1000_0000) i--;
  if (i < 0) return maxBytes; // all continuation bytes (malformed) — cut as-is
  const lead = bytes[i];
  if (lead === undefined) return maxBytes;
  let charLen: number;
  if ((lead & 0b1000_0000) === 0) charLen = 1;
  else if ((lead & 0b1110_0000) === 0b1100_0000) charLen = 2;
  else if ((lead & 0b1111_0000) === 0b1110_0000) charLen = 3;
  else if ((lead & 0b1111_1000) === 0b1111_0000) charLen = 4;
  else return maxBytes; // invalid lead byte — cut as-is
  // Keep the straddling character only if it fits entirely within the limit.
  return i + charLen <= maxBytes ? maxBytes : i;
}

/** Truncate one line to at most `maxBytes` bytes, on a UTF-8 char boundary. */
function truncateLine(line: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(line);
  if (bytes.length <= maxBytes) return { text: line, truncated: false };
  const end = utf8BoundaryLength(bytes, maxBytes);
  return { text: decoder.decode(bytes.slice(0, end)), truncated: true };
}

/**
 * The LINE_BREAKER segments an event's `_raw` was assembled from.
 *
 * breakLines records them; an event it did not build (a caller using the engine
 * as a library, say), or one whose `_raw` no longer adds up to what was
 * recorded, falls back to '\n'-separated lines — exactly the segments the
 * default LINE_BREAKER produces, since breakLines joins merged segments with
 * '\n'.
 */
function splitIntoSegments(event: SplunkEvent): string[] {
  const lengths = segmentLengthsOf(event);
  const raw = event._raw;
  if (lengths !== undefined) {
    const expected = lengths.reduce((sum, n) => sum + n, 0) + Math.max(lengths.length - 1, 0);
    if (expected === raw.length) {
      const segments: string[] = [];
      let start = 0;
      for (const length of lengths) {
        segments.push(raw.slice(start, start + length));
        start += length + 1; // step over the '\n' the merge inserted
      }
      return segments;
    }
  }
  return raw.split('\n');
}

export function truncateEvents(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
): SplunkEvent[] {
  const truncateDir = directives.find((d) => d.key === 'TRUNCATE');
  const isDefault = !truncateDir;
  const rawValue = truncateDir?.value.trim() ?? '';
  const maxBytes = truncateDir ? parseInt(rawValue, 10) : 10000;

  // TRUNCATE must be a clean non-negative integer (byte count). parseInt is far
  // too lenient — "0x10"→0 (silently disables truncation), "1e3"→1 (truncates
  // every event to ~1 byte), "100abc"→100 (no warning) — so validate the exact
  // form and ignore anything else, as real Splunk does, rather than silently
  // truncating with a wrong length or blanking the whole preview.
  if (truncateDir && !/^\d+$/.test(rawValue)) {
    diagnostics?.push({
      level: 'warning',
      message: `TRUNCATE = "${rawValue}" is not a valid byte count and was ignored. TRUNCATE expects a non-negative integer (default 10000; 0 disables truncation).`,
      file: 'props.conf',
      ...atDirective(truncateDir),
      directiveKey: truncateDir.key,
    });
    return events;
  }

  if (maxBytes <= 0) return events;

  return events.map((event) => {
    // TRUNCATE is a per-*line* byte cap, applied by Splunk's LineBreakingProcessor
    // to each line-breaker segment *before* the aggregator merges them. Measuring
    // the whole merged `_raw` would wrongly truncate a long multi-line event whose
    // individual lines are all short (Splunk leaves that intact; MAX_EVENTS caps
    // line count instead).
    //
    // A "line" is a LINE_BREAKER segment, which is not the same as a
    // '\n'-separated piece: a custom breaker can keep a whole pretty-printed JSON
    // record in one segment, and Splunk caps that record as one line (#287).
    // Splitting on '\n' let it through uncut however long it was.
    const lines = splitIntoSegments(event);
    let truncatedLines = 0;
    const newLines = lines.map((line) => {
      const { text, truncated } = truncateLine(line, maxBytes);
      if (truncated) truncatedLines++;
      return text;
    });
    if (truncatedLines === 0) return event;

    const suffix = isDefault ? ' (TRUNCATE default)' : ` (TRUNCATE=${maxBytes})`;
    const plural = truncatedLines === 1 ? 'line' : 'lines';
    return {
      ...event,
      _raw: newLines.join('\n'),
      // Splunk marks a truncated event with `meta = truncated`, which is the
      // only thing downstream has to tell a cut event from a naturally short
      // one -- the text itself carries no evidence of what was removed.
      fields: { ...event.fields, meta: 'truncated' },
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'truncator',
          phase: 'index-time' as const,
          description: `Truncated ${truncatedLines} ${plural} to ${maxBytes} bytes each${suffix}`,
          inputSnapshot: event._raw.substring(0, 100) + '...',
        },
      ],
    };
  });
}
