/**
 * Line Breaker Processor
 *
 * Simulates Splunk's line breaking and merging pipeline.
 * Uses LINE_BREAKER to split raw data into segments, then optionally
 * merges segments based on SHOULD_LINEMERGE and related directives.
 */

import type { ConfDirective, EventMetadata, SplunkEvent, ValidationDiagnostic } from '../types';
import { safeRegex, validateRegex, type SplunkRegex } from '../../utils/splunkRegex';
import { atDirective } from '../parser/provenance';
import { effectiveDirective, parseSplunkBool } from '../utils/directiveValues';
import { createTimestampFinder, readTimestampLocation } from './timestampRecognizer';

const XML_EXTRACTIONS = new Set(['xml', 'xmlkv', 'xmlkv-winevt']);

/** How many capturing groups a pattern declares, or 0 if it will not compile. */
function countCaptureGroups(pattern: string | undefined): number {
  if (pattern === undefined) return 0;
  return safeRegex(pattern)?.captureCount ?? 0;
}

/**
 * The raw, untrimmed value: the break patterns read through this are regexes,
 * where trailing whitespace is part of the pattern.
 *
 * The key comparison is case-SENSITIVE, like every other processor. Splunk
 * attribute names are case-sensitive, and `confParser` warns that a mis-cased
 * one "is ignored"; honouring it here would break events by a directive the
 * user was just told is dead.
 */
function getDirective(directives: ConfDirective[], key: string): string | undefined {
  return effectiveDirective(directives, key)?.value;
}

/**
 * The test BREAK_ONLY_BEFORE_DATE applies to a line.
 *
 * props.conf.spec: a new event starts "only if it encounters a new line with
 * a date", and the setting is "not meaningful" when DATETIME_CONFIG stops
 * timestamps being identified -- the date is the one timestamp recognition
 * finds (doc-derived). So a line has a date exactly when the extractor would
 * read a timestamp from it: the same recogniser, under the stanza's
 * TIME_PREFIX, TIME_FORMAT and MAX_TIMESTAMP_LOOKAHEAD. A date past the
 * lookahead (a stack frame quoting a log line) does not split the event, and a
 * TIME_PREFIX that will not compile finds no date, as it finds no `_time`.
 */
function dateLineTest(directives: ConfDirective[]): (line: string) => boolean {
  const finder = createTimestampFinder(readTimestampLocation(directives));
  return (line) => finder.find(line).found;
}

/**
 * The LINE_BREAKER segments each event was built from, as character lengths
 * in `_raw` order (merged segments are joined by one `\n`).
 *
 * TRUNCATE caps a *line*, and props.conf.spec defines a line as what
 * LINE_BREAKER delimits, before line merging — not a `\n`-separated piece of
 * the final event. With the default breaker the two coincide; with a custom
 * one a segment can span many `\n`s (a pretty-printed JSON record), and only
 * the breaker knows where it ends. Kept beside the event rather than on it so
 * the event shape every consumer sees, serialises and compares is unchanged;
 * an event the breaker did not produce simply has no entry.
 */
const segmentLengths = new WeakMap<SplunkEvent, number[]>();

/** The LINE_BREAKER segment lengths `event` was built from, if breakLines built it. */
export function segmentLengthsOf(event: SplunkEvent): readonly number[] | undefined {
  return segmentLengths.get(event);
}

/** Number of input lines a segment contributes (1 + embedded newlines). */
function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') n++;
  }
  return n;
}

/**
 * Build a sorted array of newline character offsets for the entire rawData.
 * Called once per breakLines invocation; subsequent lookups are O(log n).
 */
function buildNewlineIndex(rawData: string): number[] {
  const newlines: number[] = [];
  for (let i = 0; i < rawData.length; i++) {
    if (rawData[i] === '\n') newlines.push(i);
  }
  return newlines;
}

/**
 * Return the 1-indexed line number at a given character offset using the
 * pre-built newline index (binary search).
 */
function lineAtOffset(newlines: number[], offset: number): number {
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const boundary = newlines[mid];
    if (boundary !== undefined && boundary < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * Warn when a line-merging break pattern was supplied but could not be compiled.
 * The option is then dropped, which quietly rewrites event boundaries.
 */
function warnUncompilableBreakPattern(
  key: 'BREAK_ONLY_BEFORE' | 'MUST_BREAK_AFTER' | 'MUST_NOT_BREAK_AFTER',
  pattern: string | undefined,
  compiled: SplunkRegex | null,
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
): void {
  if (!diagnostics || pattern === undefined || compiled !== null) return;
  diagnostics.push({
    level: 'warning',
    message: `${key} pattern (${pattern}) does not compile (${validateRegex(pattern) ?? 'invalid regex'}). The option was ignored, so events were broken as if it were not set.`,
    file: 'props.conf',
    ...atDirective(effectiveDirective(directives, key)),
    directiveKey: key,
  });
}

const DEFAULT_LINE_BREAKER = '([\\r\\n]+)';

/** A LINE_BREAKER segment and where it starts in the raw input. */
interface Segment {
  text: string;
  offset: number;
}

/**
 * An event's text after line merging. `lines` is the length of each
 * LINE_BREAKER segment it was built from, in order (see segmentLengthsOf).
 * `end` is where its last segment ends in the raw input. It cannot be derived
 * from `offset + text.length`: merged segments are joined by one `\n`, while
 * the break they replaced may have been `\r\n` or a run of blank lines, so the
 * joined text is shorter than the input it spans.
 */
interface MergedSegment extends Segment {
  end: number;
  lines: number[];
}

/**
 * The LINE_BREAKER pattern in force.
 *
 * LINE_BREAKER identifies the break by its CAPTURE GROUP, so a pattern with
 * no group names nothing to remove and Splunk falls back to the default —
 * breaking on newlines, which leaves the would-be delimiter as an event of
 * its own.
 */
function resolveLineBreaker(
  declared: string | undefined,
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
): string {
  if (declared === undefined) return DEFAULT_LINE_BREAKER;
  if (countCaptureGroups(declared) > 0) return declared;
  diagnostics?.push({
    level: 'warning',
    message:
      `LINE_BREAKER pattern (${declared}) has no capturing group, so it names nothing ` +
      'to break on. Splunk falls back to breaking on newlines, and the text this pattern matches ' +
      'becomes an event of its own. Wrap the delimiter in parentheses to break on it.',
    file: 'props.conf',
    ...atDirective(effectiveDirective(directives, 'LINE_BREAKER')),
    directiveKey: 'LINE_BREAKER',
  });
  return DEFAULT_LINE_BREAKER;
}

/**
 * Split the raw input into the non-empty segments LINE_BREAKER delimits.
 *
 * Splunk LINE_BREAKER semantics: the text captured by the pattern's first
 * group is the separator and is discarded; everything before it ends the
 * current segment, and any text between the end of the group and the end of
 * the full match starts the next one.
 *
 * Matches are iterated over the WHOLE input from an offset rather than over a
 * re-sliced remainder, so a lookbehind can see the text already consumed —
 * `(?<=\})(\n)` sees the `}` that ended the previous event — and the tail of
 * the input is not copied once per event, which would be quadratic.
 */
function splitSegments(
  rawData: string,
  pattern: string,
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
): Segment[] {
  const lineBreakerRegex = safeRegex(pattern);
  if (!lineBreakerRegex) {
    // Invalid regex — treat entire data as one segment. A user-supplied
    // LINE_BREAKER that fails to compile silently disables event breaking, so
    // surface it (the default '([\r\n]+)' always compiles, so this is a real config).
    if (diagnostics && getDirective(directives, 'LINE_BREAKER') !== undefined) {
      diagnostics.push({
        level: 'warning',
        message: `LINE_BREAKER pattern (${pattern}) does not compile (${validateRegex(pattern) ?? 'invalid regex'}). Event breaking was skipped — the entire input is treated as one event.`,
        file: 'props.conf',
        ...atDirective(effectiveDirective(directives, 'LINE_BREAKER')),
      });
    }
    return [{ text: rawData, offset: 0 }];
  }

  const segments: Segment[] = [];
  const pushSegment = (start: number, end: number) => {
    if (end > start) segments.push({ text: rawData.slice(start, end), offset: start });
  };
  // `segmentStart` is where the event being built begins; `searchFrom` is
  // where the next search starts. They differ only after a zero-width
  // break was refused, below.
  let segmentStart = 0;
  let searchFrom = 0;

  while (searchFrom <= rawData.length) {
    const m = lineBreakerRegex.exec(rawData, searchFrom);
    if (!m) {
      // A search stopped by a PCRE limit breaks nothing further, as a
      // failed match would; say so rather than leave one oversized event
      // unexplained.
      if (lineBreakerRegex.lastError !== undefined && diagnostics) {
        diagnostics.push({
          level: 'warning',
          message:
            `LINE_BREAKER pattern (${pattern}) stopped at character ${searchFrom}: ` +
            `${lineBreakerRegex.lastError}. The rest of the input was not broken.`,
          file: 'props.conf',
          ...atDirective(effectiveDirective(directives, 'LINE_BREAKER')),
          directiveKey: 'LINE_BREAKER',
        });
      }
      break;
    }

    // The captured group is the separator to discard. A match in which the
    // group did not participate (`(a)|b` matching `b`) has no group
    // offsets, so the whole match stands in for it.
    const groupIndices = m.indices[1];
    const captureStart = groupIndices ? groupIndices[0] : m.index;
    const captureEnd = groupIndices ? groupIndices[1] : m.end;

    // A break that would not move the event start forward is no break: an
    // empty capture at the start of the current event (`()(?=b)` just
    // after a previous break) would otherwise end an empty event there, or
    // split the next character off as an event of its own. Retry one
    // character further on, which is where the next genuine break can begin.
    if (captureEnd <= segmentStart) {
      searchFrom = m.index + 1;
      continue;
    }

    pushSegment(segmentStart, captureStart);
    segmentStart = captureEnd;
    searchFrom = captureEnd;
  }

  pushSegment(segmentStart, rawData.length);
  return segments;
}

/**
 * Whether SHOULD_LINEMERGE is in force.
 *
 * SHOULD_LINEMERGE defaults to true, EXCEPT when INDEXED_EXTRACTIONS is set:
 * structured formats are one record per line, so merging would hand the
 * extractor several records glued together. For JSON that is not a subtle
 * error — `JSON.parse` of two concatenated objects throws, so the whole event
 * would extract nothing. An explicit SHOULD_LINEMERGE still wins, as it does
 * in Splunk.
 *
 * The XML modes are the exception: an XML record is a document, and
 * routinely spans lines. Splitting it per line hands the extractor a string
 * of fragments, none of which parse, and ignores the BREAK_ONLY_BEFORE the
 * user wrote to frame the record. They keep the ordinary default.
 *
 * This is the only place the default is decided; two copies of one rule drift.
 */
function shouldLineMergeFor(directives: ConfDirective[]): boolean {
  const shouldLineMergeVal = getDirective(directives, 'SHOULD_LINEMERGE');
  const structuredFormat = getDirective(directives, 'INDEXED_EXTRACTIONS')?.trim().toLowerCase();
  const structured =
    structuredFormat !== undefined && structuredFormat !== '' && structuredFormat !== 'none' &&
    !XML_EXTRACTIONS.has(structuredFormat);
  // An explicit value that is not a boolean reads as false, as it always has
  // here; it is the structured-format default that only an absent key gets.
  return shouldLineMergeVal === undefined ? !structured : parseSplunkBool(shouldLineMergeVal, false);
}

/** The line-merging rules of a stanza, compiled once per breakLines call. */
interface MergeRules {
  /** BREAK_ONLY_BEFORE, searched for anywhere in a segment. */
  breakOnlyBefore: SplunkRegex | null;
  breakOnlyBeforeDate: boolean;
  lineStartsWithDate: (line: string) => boolean;
  mustBreakAfter: SplunkRegex | null;
  mustNotBreakAfter: SplunkRegex | null;
  /** The most lines one event may total: MAX_EVENTS continuation lines plus the first. */
  maxLines: number;
  /** Whether any rule permits a segment to continue the event before it. */
  canMerge: boolean;
}

/** Compile a break pattern, warning when one was set but does not compile. */
function compileBreakPattern(
  key: 'BREAK_ONLY_BEFORE' | 'MUST_BREAK_AFTER' | 'MUST_NOT_BREAK_AFTER',
  directives: ConfDirective[],
  diagnostics: ValidationDiagnostic[] | undefined,
): SplunkRegex | null {
  const pattern = getDirective(directives, key);
  const compiled = pattern ? safeRegex(pattern) : null;
  // A pattern that will not compile silently drops the option and falls back to
  // date-only breaking, changing every event boundary with no indication why.
  // LINE_BREAKER already warns in the same situation; these must too.
  warnUncompilableBreakPattern(key, pattern, compiled, directives, diagnostics);
  return compiled;
}

function readMergeRules(directives: ConfDirective[], diagnostics?: ValidationDiagnostic[]): MergeRules {
  // Not anchored: a line that matches anywhere starts a new event, and the
  // event starts at the beginning of that line, not at the match. Checked on
  // Splunk 10.4.0 (#323): BREAK_ONLY_BEFORE = EVENT broke before
  // `a EVENT 2 is mid-line` and before `  EVENT 3`.
  const breakOnlyBefore = compileBreakPattern('BREAK_ONLY_BEFORE', directives, diagnostics);
  // Splunk default: BREAK_ONLY_BEFORE_DATE=true when SHOULD_LINEMERGE=true.
  // Only disabled when explicitly set to a false spelling.
  const breakOnlyBeforeDate = parseSplunkBool(getDirective(directives, 'BREAK_ONLY_BEFORE_DATE'), true);
  const lineStartsWithDate = dateLineTest(directives);
  const mustBreakAfter = compileBreakPattern('MUST_BREAK_AFTER', directives, diagnostics);

  // The negative half of the merging rules. MUST_NOT_BREAK_BEFORE is
  // deliberately NOT read: three captures (linebreak-must-not-break-before,
  // -explicit, -forced) measure Splunk 10.4.0 breaking anyway against a
  // date rule, BREAK_ONLY_BEFORE, and a MUST_BREAK_AFTER-forced break — the
  // spec sentence describes a suppression no observable configuration
  // exhibits, so the faithful simulation is no effect at all.
  const mustNotBreakAfter = compileBreakPattern('MUST_NOT_BREAK_AFTER', directives, diagnostics);

  // MAX_EVENTS caps how many CONTINUATION lines may be merged into an event,
  // not how many lines the event may total: MAX_EVENTS = 3 produces a
  // four-line event, as the `linebreak-max-events` capture records.
  const maxEventsStr = getDirective(directives, 'MAX_EVENTS');
  const parsedMaxEvents = maxEventsStr !== undefined ? parseInt(maxEventsStr.trim(), 10) : 256;
  const maxContinuationLines =
    Number.isFinite(parsedMaxEvents) && parsedMaxEvents > 0 ? parsedMaxEvents : 256;

  // MUST_BREAK_AFTER adds a mandatory break; it does not license merging up to
  // that break. When it is the ONLY rule in force — BREAK_ONLY_BEFORE absent
  // and BREAK_ONLY_BEFORE_DATE explicitly false — Splunk has no rule saying
  // when to continue an event, so it breaks on every line.
  //
  // Deliberately narrow: with no MUST_BREAK_AFTER either, merging still
  // happens (bounded by MAX_EVENTS), which is what Splunk documents
  // and what no capture contradicts.
  const canMerge = breakOnlyBefore !== null || breakOnlyBeforeDate || mustBreakAfter === null;

  return {
    breakOnlyBefore,
    breakOnlyBeforeDate,
    lineStartsWithDate,
    mustBreakAfter,
    mustNotBreakAfter,
    maxLines: maxContinuationLines + 1,
    canMerge,
  };
}

type BreakReason = 'must-break-after' | 'no-merge-rule' | 'max-events' | 'break-only-before' | 'date';

/** The state line merging carries from one segment to the next. */
interface MergeState {
  currentLineCount: number;
  forceBreakNext: boolean;
  /**
   * MUST_NOT_BREAK_AFTER is stateful: once a line matches, rule-driven breaks
   * stay suppressed until a line matches MUST_BREAK_AFTER. Without one, the
   * suppression runs to the end of the input.
   */
  suppressBreaks: boolean;
}

/**
 * Why `seg` starts a new event, or null when it continues the current one.
 *
 * The rule that asked for the break is kept because it decides whether a veto
 * can stand against it: positive rules are weighed in precedence order, then
 * the vetoes are applied.
 */
function breakReason(seg: Segment, segLines: number, rules: MergeRules, state: MergeState): BreakReason | null {
  const overCap = state.currentLineCount + segLines > rules.maxLines;
  let reason: BreakReason | null = null;
  if (state.forceBreakNext) reason = 'must-break-after';
  else if (!rules.canMerge) reason = 'no-merge-rule';
  else if (overCap) reason = 'max-events';
  else if (rules.breakOnlyBefore !== null && rules.breakOnlyBefore.test(seg.text)) reason = 'break-only-before';
  else if (rules.breakOnlyBeforeDate && rules.lineStartsWithDate(seg.text)) reason = 'date';

  // MUST_NOT_BREAK_AFTER suppression: every rule-driven break is
  // suppressed until MUST_BREAK_AFTER matches, exactly the stateful span
  // the capture `linebreak-must-not-break-after-span` records — dated
  // lines inside the span stay merged. MAX_EVENTS is a hard cap the
  // suppression does not defeat.
  if (reason !== null && reason !== 'max-events' && state.suppressBreaks) {
    reason = overCap ? 'max-events' : null;
  }
  return reason;
}

/**
 * Carry the break state past `text`. MUST_BREAK_AFTER both forces a break
 * after a matching line and ends a MUST_NOT_BREAK_AFTER suppression; a line
 * matching MUST_NOT_BREAK_AFTER (re)starts one from the next line on.
 */
function advanceBreakState(text: string, rules: MergeRules, state: MergeState): void {
  if (rules.mustBreakAfter) {
    const matched = rules.mustBreakAfter.test(text);
    if (matched) state.suppressBreaks = false;
    state.forceBreakNext = matched;
  }
  if (rules.mustNotBreakAfter && rules.mustNotBreakAfter.test(text)) {
    state.suppressBreaks = true;
  }
}

function startEvent(seg: Segment): MergedSegment {
  return { text: seg.text, offset: seg.offset, end: seg.offset + seg.text.length, lines: [seg.text.length] };
}

/** Apply SHOULD_LINEMERGE's rules, joining continuation segments with `\n`. */
function mergeSegments(
  first: Segment,
  rest: Segment[],
  rules: MergeRules,
): { merged: MergedSegment[]; maxEventsTriggered: boolean } {
  const merged = [startEvent(first)];
  let maxEventsTriggered = false;
  const state: MergeState = {
    currentLineCount: countLines(first.text),
    forceBreakNext: rules.mustBreakAfter !== null && rules.mustBreakAfter.test(first.text),
    suppressBreaks: rules.mustNotBreakAfter !== null && rules.mustNotBreakAfter.test(first.text),
  };

  for (const seg of rest) {
    const segLines = countLines(seg.text);
    const reason = breakReason(seg, segLines, rules, state);
    state.forceBreakNext = false;
    if (reason === 'max-events') maxEventsTriggered = true;

    if (reason !== null) {
      merged.push(startEvent(seg));
      state.currentLineCount = segLines;
    } else {
      const prev = merged.at(-1);
      if (prev !== undefined) {
        prev.text += '\n' + seg.text;
        prev.end = seg.offset + seg.text.length;
        prev.lines.push(seg.text.length);
      }
      state.currentLineCount += segLines;
    }
    advanceBreakState(seg.text, rules, state);
  }
  return { merged, maxEventsTriggered };
}

function toEvent(seg: MergedSegment, newlines: number[], metadata: EventMetadata): SplunkEvent {
  const lineNums = {
    start: lineAtOffset(newlines, seg.offset),
    // `seg.end` is exclusive: the line of its LAST character, not of the one
    // after it. A segment ending in `\n` (a custom LINE_BREAKER whose capture
    // group leaves the newline in the event) would otherwise report its end
    // on the following line.
    end: lineAtOffset(newlines, Math.max(seg.offset, seg.end - 1)),
  };
  const event: SplunkEvent = {
    _raw: seg.text,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { ...metadata },
    lineNumbers: lineNums,
    processingTrace: [
      {
        processor: 'lineBreaker',
        phase: 'index-time',
        description: `LINE_BREAKER split raw data into segment (lines ${lineNums.start}-${lineNums.end})`,
        outputSnapshot: seg.text.substring(0, 200),
        fieldsAdded: [],
        fieldsModified: [],
      },
    ],
  };
  segmentLengths.set(event, seg.lines);
  return event;
}

/** Record on every event how many segments line merging joined, and by which rules. */
function traceMerge(
  events: SplunkEvent[],
  directives: ConfDirective[],
  segmentCount: number,
  maxEventsTriggered: boolean,
): void {
  const mergeInfo: string[] = [];
  for (const key of ['BREAK_ONLY_BEFORE', 'BREAK_ONLY_BEFORE_DATE', 'MUST_BREAK_AFTER', 'MUST_NOT_BREAK_AFTER']) {
    const value = getDirective(directives, key);
    if (value) mergeInfo.push(`${key}=${value}`);
  }
  if (maxEventsTriggered) {
    mergeInfo.push(`MAX_EVENTS=${getDirective(directives, 'MAX_EVENTS') ?? '256'} (line cap forced a break)`);
  }
  for (const ev of events) {
    ev.processingTrace.push({
      processor: 'lineBreaker',
      phase: 'index-time',
      description:
        `SHOULD_LINEMERGE=true merged ${segmentCount} segments into ${events.length} events` +
        (mergeInfo.length > 0 ? ` (${mergeInfo.join(', ')})` : ''),
      fieldsAdded: [],
      fieldsModified: [],
    });
  }
}

/**
 * Break raw data into SplunkEvent objects according to props.conf directives.
 *
 * Processing order mirrors Splunk:
 *  1. Apply LINE_BREAKER to split raw data into segments.
 *  2. If SHOULD_LINEMERGE is true (default), merge segments according to
 *     BREAK_ONLY_BEFORE, BREAK_ONLY_BEFORE_DATE, and MUST_BREAK_AFTER.
 *  3. Create SplunkEvent objects from the resulting segments.
 */
export function breakLines(
  rawData: string,
  directives: ConfDirective[],
  metadata: EventMetadata,
  diagnostics?: ValidationDiagnostic[],
): SplunkEvent[] {
  if (!rawData || rawData.length === 0) {
    return [];
  }

  const pattern = resolveLineBreaker(getDirective(directives, 'LINE_BREAKER'), directives, diagnostics);
  const segments = splitSegments(rawData, pattern, directives, diagnostics);
  const [firstSegment, ...restSegments] = segments;
  if (firstSegment === undefined) {
    return [];
  }

  const shouldLineMerge = shouldLineMergeFor(directives);
  const { merged, maxEventsTriggered } = shouldLineMerge
    ? mergeSegments(firstSegment, restSegments, readMergeRules(directives, diagnostics))
    : { merged: segments.map(startEvent), maxEventsTriggered: false };

  const newlines = buildNewlineIndex(rawData);
  const events = merged.map((seg) => toEvent(seg, newlines, metadata));
  if (shouldLineMerge && segments.length !== merged.length) {
    traceMerge(events, directives, segments.length, maxEventsTriggered);
  }
  return events;
}
