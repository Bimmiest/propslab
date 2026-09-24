import { safeRegex } from '../utils/splunkRegex';
import { parseTimestampDetailed, parseTzAlias } from '../utils/strftime';
import { matchTimeFormat, timeFormatRegex } from './processors/timestampExtractor';

/**
 * Timestamp probing for the Timestamp tab, extracted from the component so it
 * can run in a Web Worker.
 *
 * It has to be off the render thread because TIME_PREFIX is a user-supplied
 * regex executed against `_raw`. `safeRegex`'s ReDoS heuristic is structural and
 * documents what it cannot see — alternation-overlap forms such as `(a|aa)+` —
 * and those remain the caller's problem. On the main thread there was nothing to
 * terminate: `^(a|a)*b$` against a thirty-character line took about 32 seconds in
 * a cold process, growing roughly fourfold per two characters added, with no
 * diagnostic, because the refusal path is what would have produced one.
 *
 * Typing a TIME_PREFIX is an ordinary thing to do, and a pattern does not have
 * to be hostile to be catastrophic — only ambiguous.
 */

export interface TimeConfig {
  timePrefix: string | null;
  timeFormat: string | null;
  maxLookahead: number;
  tz: string | null;
  /**
   * The TZ_ALIAS value as written, parsed here the way the extractor parses
   * it. A string rather than the parsed Map so the config stays plain data: it
   * crosses the worker boundary, and the tab compares configs by value.
   * Optional so a caller without one keeps working.
   */
  tzAlias?: string | null;
  /**
   * The moment standing in for index time, in epoch ms — the same value as
   * `PipelineOptions.now`, which gives a yearless TIME_FORMAT its year. Omitted,
   * both fall back to the clock. Without it the prober and a pipeline run with
   * a fixed `now` put the same timestamp in different years (#313).
   */
  now?: number;
}

export interface TimestampMatch {
  prefixStart: number;
  prefixEnd: number;
  lookaheadEnd: number;
  tsStart: number;
  tsEnd: number;
  /**
   * Milliseconds since the epoch, or null when the matched text did not parse.
   *
   * A number rather than a `Date` because this crosses a worker boundary: a
   * structured-cloned `Date` survives, but keeping the wire format primitive
   * means the tab renders the same whether the result came from the worker or
   * from the inline fallback.
   */
  parsedTimeMs: number | null;
  matchedText: string;
}

/**
 * What a probe found, which is not the same question as "did it match".
 *
 * The overlay renders the lookahead window whenever TIME_PREFIX matched, even
 * when TIME_FORMAT then did not — that is the case a user most needs to see,
 * because it distinguishes "the prefix is wrong" from "the format is wrong".
 * Carrying the prefix span separately is what lets the overlay draw it without
 * re-running the regex on the render thread.
 */
export interface TimestampProbe {
  match: TimestampMatch | null;
  prefix: { start: number; end: number; lookaheadEnd: number } | null;
}

const EMPTY: TimestampProbe = { match: null, prefix: null };

/**
 * What a config compiles to, once per batch rather than once per event. The
 * TIME_FORMAT regex comes from the extractor's own `timeFormatRegex`, so the
 * prober and the pipeline search the lookahead window identically: anchored
 * right after TIME_PREFIX when there is one. The prober used to scan the window
 * unanchored, and highlighted a date the pipeline then rejected (#313).
 */
interface CompiledTimeConfig {
  config: TimeConfig;
  /** undefined: no TIME_PREFIX, or an empty one. null: one that will not compile. */
  prefixRegex: RegExp | null | undefined;
  formatRegex: RegExp | null;
  tzAlias: ReadonlyMap<string, string>;
  now: Date | undefined;
}

function compile(config: TimeConfig): CompiledTimeConfig {
  // Trimmed, and empty read as unset, the way the extractor reads it (#328).
  const timePrefix = config.timePrefix?.trim() || undefined;
  const prefixRegex = timePrefix !== undefined ? safeRegex(timePrefix) : undefined;
  return {
    config,
    prefixRegex,
    formatRegex: config.timeFormat ? timeFormatRegex(config.timeFormat, prefixRegex != null) : null,
    tzAlias: parseTzAlias(config.tzAlias ?? '').aliases,
    now: config.now !== undefined ? new Date(config.now) : undefined,
  };
}

function probe(raw: string, compiled: CompiledTimeConfig): TimestampProbe {
  const { config, prefixRegex, formatRegex } = compiled;
  let prefixStart = 0;
  let prefixEnd = 0;
  let prefix: TimestampProbe['prefix'] = null;

  if (prefixRegex !== undefined) {
    if (!prefixRegex) return EMPTY;
    const prefixMatch = prefixRegex.exec(raw);
    if (!prefixMatch) return EMPTY;
    prefixStart = prefixMatch.index;
    prefixEnd = prefixMatch.index + prefixMatch[0].length;
    prefix = {
      start: prefixStart,
      end: prefixEnd,
      lookaheadEnd: Math.min(prefixEnd + config.maxLookahead, raw.length),
    };
  }

  // Reported after the prefix so the overlay can still draw the lookahead window
  // for a config that has a TIME_PREFIX but no TIME_FORMAT yet — the state a user
  // is in halfway through writing one.
  if (!config.timeFormat || !formatRegex) return { match: null, prefix };

  const lookaheadEnd = Math.min(prefixEnd + config.maxLookahead, raw.length);
  const formatMatch = matchTimeFormat(raw, prefixEnd, lookaheadEnd, formatRegex);
  if (!formatMatch) return { match: null, prefix };

  // Parsed with the same inputs the extractor passes — TZ, TZ_ALIAS and `now` —
  // so the value shown is the one the pipeline reads (#313). A dateless format
  // is the exception: the extractor dates it from the previous event, which a
  // per-event probe has no view of, and it lands on 1 January here.
  const parsed = parseTimestampDetailed(formatMatch.text, config.timeFormat, {
    tz: config.tz ?? undefined,
    tzAlias: compiled.tzAlias,
    now: compiled.now,
  });

  return {
    match: {
      prefixStart,
      prefixEnd,
      lookaheadEnd,
      tsStart: formatMatch.start,
      tsEnd: formatMatch.end,
      parsedTimeMs: parsed ? parsed.date.getTime() : null,
      matchedText: raw.substring(formatMatch.start, formatMatch.end),
    },
    prefix,
  };
}

export function probeTimestamp(raw: string, config: TimeConfig): TimestampProbe {
  return probe(raw, compile(config));
}

/** Probe many events under one config. Aligned to `raws`. */
export function probeTimestamps(raws: string[], config: TimeConfig): TimestampProbe[] {
  const compiled = compile(config);
  return raws.map((raw) => probe(raw, compiled));
}
