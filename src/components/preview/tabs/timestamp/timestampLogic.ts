import { parseConf } from '../../../../engine/parser/confParser';
import { mergeDirectives, resolveStanzasForEvent } from '../../../../engine/parser/stanzaMatcher';
import { resolveLookahead } from '../../../../engine/processors/timestampExtractor';
import type { TimeConfig, TimestampProbe } from '../../../../engine/timestampMatch';
import type { EventMetadata, SplunkEvent, TimeSource } from '../../../../engine/types';
import { formatSpecifiers } from '../../../../utils/strftime';
import { STRPTIME_REFERENCE } from './data';

// TimeConfig / TimestampMatch / the probe itself now live in
// `engine/timestampMatch`, so the worker and this tab share one definition.

// Resolve the time directives the ENGINE would actually apply for the current
// metadata — using the same parse → stanza-match → merge path as the pipeline —
// rather than flat-scanning every line. A flat scan would surface a TIME_FORMAT
// from a stanza that never matched this event's sourcetype/host/source.
// `resolveStanzasForEvent`, as the pipeline resolves them, so a `sourcetype =`
// assigned in a [source::] or [host::] stanza picks the time settings of the
// stanza it names rather than those of the sourcetype it replaced.
export function parseTimeConfig(propsConf: string, metadata: EventMetadata): TimeConfig {
  const { stanzas } = resolveStanzasForEvent(parseConf(propsConf, 'props.conf').stanzas, metadata);
  const directives = mergeDirectives(stanzas);
  const get = (key: string) => directives.find((d) => d.key === key)?.value.trim();
  return {
    // An empty TIME_PREFIX is unset, as the extractor reads it.
    timePrefix: get('TIME_PREFIX') || null,
    timeFormat: get('TIME_FORMAT') ?? null,
    // Shared with the engine so 0 / -1 (no limit) draw the window it scans.
    maxLookahead: resolveLookahead(get('MAX_TIMESTAMP_LOOKAHEAD')),
    tz: get('TZ') ?? null,
    // Handed to the prober so a %Z the alias table remaps parses to the same
    // instant the pipeline gives it. `now` is left to the clock, which is
    // what the app's pipeline runs use too.
    tzAlias: get('TZ_ALIAS') ?? null,
  };
}

const DESCRIPTIONS = new Map(
  STRPTIME_REFERENCE.flatMap((cat) => cat.directives.map((d) => [d.directive, d.description] as const)),
);

/** The directives in a format, in order, as the parser tokenises it, each with its reference description. */
export function extractDirectives(format: string): { directive: string; description: string }[] {
  const result: { directive: string; description: string }[] = [];
  for (const { specifier, supported } of formatSpecifiers(format)) {
    // The %% escape is literal text, not a field of the timestamp.
    const description = DESCRIPTIONS.get(specifier);
    if (supported && specifier !== '%%' && description) result.push({ directive: specifier, description });
  }
  return result;
}

/**
 * The text timestamp extraction read for this event — `_raw` before SEDCMD,
 * DEST_KEY = _raw and INGEST_EVAL rewrote it — or `_raw` itself when the
 * extractor recorded none.
 */
export function timestampTextOf(event: SplunkEvent): string {
  return event.timestampText ?? event._raw;
}

/** How the pipeline actually resolved this event's `_time`. */
export function resolvedTimeSource(event: SplunkEvent): TimeSource | undefined {
  return event.processingTrace
    .filter((step) => step.processor === 'timestampExtractor')
    .at(-1)?.timeSource;
}

/** A run of an event's text and how the overlay draws it. */
export interface OverlaySegment {
  key: string;
  /**
   * `outside`: before the prefix or past the lookahead, muted. `prefix`: the
   * TIME_PREFIX match. `window`: lookahead text around the timestamp, plain.
   * `gap`: text between the prefix and the timestamp. `timestamp`: the
   * TIME_FORMAT match. `boundary`: the lookahead-end marker.
   */
  kind: 'outside' | 'prefix' | 'window' | 'gap' | 'timestamp' | 'boundary';
  text: string;
  title?: string;
}

/**
 * `raw` split for the overlay, or null to draw it plain (no match and no
 * prefix match). The prefix span comes back on the probe rather than being
 * re-derived here: the user's TIME_PREFIX must never run during render, where
 * no watchdog can stop it.
 */
export function overlaySegments(raw: string, probe: TimestampProbe | null, config: TimeConfig): OverlaySegment[] | null {
  const result = probe?.match ?? null;
  const segments: OverlaySegment[] = [];
  if (!result) {
    // No match — show the full lookahead window if the prefix matched.
    const prefix = probe?.prefix;
    if (!prefix) return null;
    const { start: pStart, end: pEnd, lookaheadEnd: laEnd } = prefix;
    if (pStart > 0) segments.push({ key: 'pre', kind: 'outside', text: raw.substring(0, pStart) });
    segments.push({ key: 'prefix', kind: 'prefix', text: raw.substring(pStart, pEnd) });
    segments.push({ key: 'la', kind: 'window', text: raw.substring(pEnd, laEnd) });
    segments.push({ key: 'la-marker', kind: 'boundary', text: ']' });
    if (laEnd < raw.length) segments.push({ key: 'post', kind: 'outside', text: raw.substring(laEnd) });
    return segments;
  }

  let cursor = 0;

  // Before prefix
  if (result.prefixStart > cursor) {
    segments.push({ key: 'pre-prefix', kind: 'outside', text: raw.substring(cursor, result.prefixStart) });
    cursor = result.prefixStart;
  }

  // Prefix region (only if TIME_PREFIX was configured and matched something)
  if (config.timePrefix && result.prefixEnd > result.prefixStart) {
    segments.push({
      key: 'prefix', kind: 'prefix', text: raw.substring(cursor, result.prefixEnd), title: `TIME_PREFIX: ${config.timePrefix}`,
    });
    cursor = result.prefixEnd;
  }

  // Between prefix end and timestamp start (within lookahead)
  if (result.tsStart > cursor) {
    segments.push({ key: 'pre-ts', kind: 'gap', text: raw.substring(cursor, result.tsStart) });
    cursor = result.tsStart;
  }

  const parsed = result.parsedTimeMs != null ? new Date(result.parsedTimeMs).toISOString() : 'failed';
  segments.push({
    key: 'ts', kind: 'timestamp', text: raw.substring(cursor, result.tsEnd), title: `TIME_FORMAT: ${config.timeFormat}\nParsed: ${parsed}`,
  });
  cursor = result.tsEnd;

  // Rest of lookahead window after timestamp
  if (result.lookaheadEnd > cursor) {
    segments.push(
      { key: 'post-ts-la', kind: 'window', text: raw.substring(cursor, result.lookaheadEnd) },
      { key: 'la-marker', kind: 'boundary', text: ']' },
    );
    cursor = result.lookaheadEnd;
  }

  // After lookahead
  if (cursor < raw.length) segments.push({ key: 'post', kind: 'outside', text: raw.substring(cursor) });

  return segments;
}
