import {
  parseConf,
  mergeDirectives,
  resolveStanzasForEvent,
  resolveLookahead,
  locateTimestamp,
  type TimeConfig,
  type TimestampMatch,
  type TimestampProbe,
  FALLBACK_TIME_SOURCES,
  type EventMetadata,
  type TimeSource,
  formatSpecifiers,
} from 'propslab-engine';
import type { TraceStep, ViewEvent } from '../../../../utils/viewResult';
import { FALLBACK_LABEL, STRPTIME_REFERENCE } from './data';

// TimeConfig / TimestampMatch / the probe itself now live in
// the engine's `timestampMatch`, so the worker and this tab share one definition.

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

/**
 * Whether the parser implements `specifier`, asked of the same tokeniser the
 * editor's "not simulated" warning uses, so the reference and the linter agree.
 */
export function isSimulated(specifier: string): boolean {
  const tokens = formatSpecifiers(specifier);
  const [only, ...rest] = tokens;
  return only !== undefined && rest.length === 0 && only.specifier === specifier && only.supported;
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
export function timestampTextOf(event: ViewEvent): string {
  return event.timestampText ?? event._raw;
}

/** The trace step that resolved this event's `_time`. */
export function timestampStepOf(event: ViewEvent): TraceStep | undefined {
  return event.processingTrace.filter((step) => step.processor === 'timestampExtractor').at(-1);
}

/** How the pipeline actually resolved this event's `_time`. */
export function resolvedTimeSource(event: ViewEvent): TimeSource | undefined {
  return timestampStepOf(event)?.timeSource;
}

/** Where automatic recognition read this event's `_time`, or null when it did not. */
export function recognisedRead(event: ViewEvent): { format: string; span: { start: number; end: number } } | null {
  const step = timestampStepOf(event);
  const span = event.timestampSpan;
  if (step?.timeSource !== 'auto-recognition' || step.timeFormat === undefined || span === undefined) return null;
  return { format: step.timeFormat, span };
}

/** One format that automatic recognition read, with the first event it read with it. */
export interface RecognisedFormat {
  format: string;
  count: number;
  example: { text: string; span: { start: number; end: number } };
}

/** What automatic recognition did across a run, for the tab when no TIME_FORMAT is set. */
export interface RecognitionSummary {
  /** The most common first; a tie keeps the order in which the events first used them. */
  formats: RecognisedFormat[];
  recognised: number;
  /** Events whose `_time` came from the previous event, the clock or DATETIME_CONFIG. */
  fallback: number;
}

export function summariseRecognition(events: readonly ViewEvent[]): RecognitionSummary {
  const byFormat = new Map<string, RecognisedFormat>();
  let recognised = 0;
  let fallback = 0;
  for (const event of events) {
    const read = recognisedRead(event);
    if (read) {
      recognised++;
      const entry = byFormat.get(read.format);
      if (entry) entry.count++;
      else
        byFormat.set(read.format, {
          format: read.format,
          count: 1,
          example: { text: timestampTextOf(event), span: read.span },
        });
      continue;
    }
    const source = resolvedTimeSource(event);
    if (source !== undefined && FALLBACK_TIME_SOURCES.includes(source)) fallback++;
  }
  // Array.prototype.sort is stable, so equal counts keep first-seen order.
  const formats = [...byFormat.values()].sort((a, b) => b.count - a.count);
  return { formats, recognised, fallback };
}

/**
 * The directives "Write this as TIME_FORMAT" adds for `format`: the ones the
 * scaffold writes, located from the first event read with it. A TIME_PREFIX
 * already set stays, and so does the lookahead measured from it: only
 * TIME_FORMAT is added then.
 */
export function recognisedDirectives(format: RecognisedFormat, config: TimeConfig): { key: string; value: string }[] {
  const timeFormat = { key: 'TIME_FORMAT', value: format.format };
  if (config.timePrefix) return [timeFormat];
  const { timePrefix, lookahead } = locateTimestamp(format.example.text, format.example.span);
  return [
    ...(timePrefix !== null ? [{ key: 'TIME_PREFIX', value: timePrefix }] : []),
    timeFormat,
    { key: 'MAX_TIMESTAMP_LOOKAHEAD', value: String(lookahead) },
  ];
}

/**
 * Why an event's `_time` did not come from its text, and where it came from
 * instead, or null when it did come from its text.
 */
export function fallbackReason(step: TraceStep | undefined): string | null {
  const source = step?.timeSource;
  if (source === undefined || !FALLBACK_TIME_SOURCES.includes(source)) return null;
  if (source !== 'previous-event' && source !== 'current-time') return FALLBACK_LABEL[source] ?? source;
  const why = step?.timeFallback === 'out-of-bounds' ? 'Timestamp outside the sanity bounds' : 'No timestamp found';
  return `${why} — _time from ${source === 'previous-event' ? 'the previous event' : 'the time of indexing'}`;
}

/**
 * The overlay of an event automatic recognition read: the span the engine
 * recorded, in the window the prober drew from TIME_PREFIX when one is set.
 */
export function recognisedSegments(
  raw: string,
  probe: TimestampProbe | null,
  config: TimeConfig,
  /** The read, and the `_time` it gave in epoch ms. */
  read: { format: string; span: { start: number; end: number }; timeMs: number | null },
): OverlaySegment[] | null {
  const prefix = probe?.prefix ?? null;
  const match: TimestampMatch = {
    prefixStart: prefix?.start ?? 0,
    prefixEnd: prefix?.end ?? 0,
    lookaheadEnd: prefix?.lookaheadEnd ?? Math.min(config.maxLookahead, raw.length),
    tsStart: read.span.start,
    tsEnd: read.span.end,
    parsedTimeMs: read.timeMs,
    matchedText: raw.substring(read.span.start, read.span.end),
  };
  return overlaySegments(raw, { match, prefix }, config, read.format);
}

/** The overlay kinds that `segments` draw, for a legend of only what is on screen. */
export function shownKinds(segments: readonly (readonly OverlaySegment[] | null)[]): Set<OverlaySegment['kind']> {
  return new Set(segments.flatMap((s) => (s ?? []).map((segment) => segment.kind)));
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
export function overlaySegments(
  raw: string,
  probe: TimestampProbe | null,
  config: TimeConfig,
  /** The format automatic recognition read the timestamp with, when no TIME_FORMAT is set. */
  recognisedFormat?: string,
): OverlaySegment[] | null {
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
      key: 'prefix',
      kind: 'prefix',
      text: raw.substring(cursor, result.prefixEnd),
      title: `TIME_PREFIX: ${config.timePrefix}`,
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
    key: 'ts',
    kind: 'timestamp',
    text: raw.substring(cursor, result.tsEnd),
    title: `${recognisedFormat !== undefined ? `Recognized format: ${recognisedFormat}` : `TIME_FORMAT: ${config.timeFormat}`}\nParsed: ${parsed}`,
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
