import type { SplunkEvent, ConfDirective } from '../types';
import { segmentLengthsOf } from './lineBreaker';
import type { RunContext } from '../runContext';
import { truncateLimit, truncateLine } from './truncateLine';

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

/** Takes the run context like every stage, though it reads nothing from it: the linter reports a bad value. */
export function truncateEvents(events: SplunkEvent[], directives: ConfDirective[], _ctx: RunContext): SplunkEvent[] {
  const { maxBytes, isDefault } = truncateLimit(directives);

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
    // record in one segment, and Splunk caps that record as one line.
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
          truncation: { lines: truncatedLines, limitBytes: maxBytes, isDefault },
          inputSnapshot: event._raw.substring(0, 100) + '...',
        },
      ],
    };
  });
}
