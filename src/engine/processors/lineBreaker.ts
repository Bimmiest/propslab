/**
 * Line Breaker Processor
 *
 * Simulates Splunk's line breaking and merging pipeline.
 * Uses LINE_BREAKER to split raw data into segments, then optionally
 * merges segments based on SHOULD_LINEMERGE and related directives.
 */

import type { ConfDirective, EventMetadata, SplunkEvent, ValidationDiagnostic } from '../types';
import { safeRegex } from '../../utils/splunkRegex';
import { atDirective } from '../parser/provenance';
import { effectiveDirective, parseSplunkBool } from '../utils/directiveValues';

const XML_EXTRACTIONS = new Set(['xml', 'xmlkv', 'xmlkv-winevt']);

/**
 * Find a directive by key.
 *
 * The comparison is case-SENSITIVE, like every other processor. Splunk
 * attribute names are case-sensitive, and `confParser` already warns that a
 * mis-cased one "is ignored" — matching case-insensitively here made the
 * simulator honour the very directive it had just told the user was dead
 * (`line_breaker = (X)` warned, then broke the events anyway), which is worse
 * than either behaviour alone: the warning made the wrong output look checked.
 */
/**
 * How many capturing groups a pattern declares, or 0 if it will not compile.
 *
 * Counted by compiling `pattern|` — an alternation with an empty branch always
 * matches, and the resulting array has one entry per group, which is more
 * reliable than counting unescaped `(` by hand.
 */
function countCaptureGroups(pattern: string | undefined): number {
  if (pattern === undefined) return 0;
  try {
    return new RegExp(`${pattern}|`).exec('')!.length - 1;
  } catch {
    return 0;
  }
}

/**
 * The raw, untrimmed value: the break patterns read through this are regexes,
 * where trailing whitespace is part of the pattern.
 */
function getDirective(directives: ConfDirective[], key: string): string | undefined {
  return effectiveDirective(directives, key)?.value;
}

/**
 * Date forms BREAK_ONLY_BEFORE_DATE recognises ANYWHERE in the lookahead
 * window of a line, not only at its start (#287). Splunk runs its timestamp
 * recognizer over the line, so `[2026-09-22 10:00:00] a` and a syslog line
 * behind its `<34>` priority both start events there; anchoring at `^` merged
 * every such line into the one before it.
 *
 * The digit guards keep a date from being found inside a longer number, and
 * month names must stand as words (`Mar 5` is a date, `Market 5` is not).
 */
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_ANYWHERE_PATTERN = safeRegex(
  '(?<!\\d)\\d{4}[\\-/]\\d{1,2}[\\-/]\\d{1,2}(?!\\d)' +           // 2024-01-15 or 2024/01/15
    '|(?<![\\d/\\-])\\d{1,2}[\\-/]\\d{1,2}[\\-/]\\d{2,4}(?![\\d/\\-])' + // 01-15-2024 or 1/15/24
    `|(?<![A-Za-z])${MONTH}\\.?\\s+\\d{1,2}(?!\\d)` +               // Jan 15, Sep 22 10:00:02
    `|(?<!\\d)\\d{1,2}[/\\- ]${MONTH}[/\\- ]\\d{2,4}(?!\\d)`,        // 15/Jan/2024 (CLF), 15 Jan 2024
);

/**
 * Forms recognised only at the START of a line, because anywhere else they
 * are more often data than a timestamp. A weekday alone (`Mon `) keeps the
 * reading it always had. Epoch time is a bare number, so in mid-line it is as
 * likely an id, a byte count or a port; at the start it is still accepted only
 * as a plausible epoch — 10 digits of seconds (2001–2033) or 13 of
 * milliseconds, optionally fractional, and not the prefix of a longer number.
 * Any 10–13 digit run used to count, so an 11- or 12-digit order id began a
 * new event.
 */
const DATE_AT_START_PATTERN = safeRegex(
  '^\\s*(?:' +
    '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s' +
    '|1\\d{9}(?:\\d{3})?(?:\\.\\d+)?(?![\\d.])' +
    ')',
);

/** props.conf.spec default for MAX_TIMESTAMP_LOOKAHEAD, as timestampExtractor reads it. */
const DEFAULT_TIMESTAMP_LOOKAHEAD = 128;

/** Whether a line carries a date BREAK_ONLY_BEFORE_DATE would break before. */
function lineHasDate(line: string, lookahead: number): boolean {
  if (DATE_AT_START_PATTERN?.test(line)) return true;
  // Only the lookahead window is searched, as it is for timestamp extraction:
  // a date deep inside a continuation line (a stack frame quoting a log line,
  // say) is past where Splunk's recognizer looks, and must not split the event.
  return DATE_ANYWHERE_PATTERN?.test(line.slice(0, lookahead)) ?? false;
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
 * Break raw data into SplunkEvent objects according to props.conf directives.
 *
 * Processing order mirrors Splunk:
 *  1. Apply LINE_BREAKER to split raw data into segments.
 *  2. If SHOULD_LINEMERGE is true (default), merge segments according to
 *     BREAK_ONLY_BEFORE, BREAK_ONLY_BEFORE_DATE, and MUST_BREAK_AFTER.
 *  3. Create SplunkEvent objects from the resulting segments.
 */
/**
 * Warn when a line-merging break pattern was supplied but could not be compiled.
 * The option is then dropped, which quietly rewrites event boundaries.
 */
function warnUncompilableBreakPattern(
  key: 'BREAK_ONLY_BEFORE' | 'MUST_BREAK_AFTER' | 'MUST_NOT_BREAK_AFTER',
  pattern: string | undefined,
  compiled: RegExp | null,
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
): void {
  if (!diagnostics || pattern === undefined || compiled !== null) return;
  diagnostics.push({
    level: 'warning',
    message: `${key} pattern (${pattern}) could not be compiled safely (invalid regex or rejected as ReDoS-prone). The option was ignored, so events were broken as if it were not set.`,
    file: 'props.conf',
    ...atDirective(effectiveDirective(directives, key)),
    directiveKey: key,
  });
}

export function breakLines(
  rawData: string,
  directives: ConfDirective[],
  metadata: EventMetadata,
  diagnostics?: ValidationDiagnostic[],
): SplunkEvent[] {
  if (!rawData || rawData.length === 0) {
    return [];
  }

  // ── Step 1: LINE_BREAKER ──────────────────────────────────────────
  const DEFAULT_LINE_BREAKER = '([\\r\\n]+)';
  const declaredLineBreaker = getDirective(directives, 'LINE_BREAKER');

  // LINE_BREAKER identifies the break by its CAPTURE GROUP, so a pattern with
  // no group names nothing to remove and Splunk falls back to the default —
  // breaking on newlines, which leaves the would-be delimiter as an event of
  // its own. Treating the whole match as the separator instead both failed to
  // break where Splunk does and left the newlines in `_raw` (#172).
  const groupCount = countCaptureGroups(declaredLineBreaker);
  const lineBreakerUnusable = declaredLineBreaker !== undefined && groupCount === 0;
  if (lineBreakerUnusable && diagnostics) {
    diagnostics.push({
      level: 'warning',
      message:
        `LINE_BREAKER pattern (${declaredLineBreaker}) has no capturing group, so it names nothing ` +
        'to break on. Splunk falls back to breaking on newlines, and the text this pattern matches ' +
        'becomes an event of its own. Wrap the delimiter in parentheses to break on it.',
      file: 'props.conf',
      ...atDirective(effectiveDirective(directives, 'LINE_BREAKER')),
      directiveKey: 'LINE_BREAKER',
    });
  }
  const lineBreakerPattern =
    lineBreakerUnusable || declaredLineBreaker === undefined ? DEFAULT_LINE_BREAKER : declaredLineBreaker;

  let segments: string[];
  const segmentOffsets: number[] = []; // character offset of each segment in rawData

  {
    segments = [];
    // Use the LINE_BREAKER to split.  The capturing group content is the
    // separator and is discarded; text before and between matches are segments.
    // We must handle the capturing group properly: the part outside the group
    // belongs to segments, the captured group is the separator.
    //
    // Splunk LINE_BREAKER semantics: the regex must have exactly one
    // capturing group.  Everything before the first match is part of the
    // first segment.  Between matches, the text NOT captured by the group
    // belongs to the adjacent segments:
    //   - Text from the end of the *previous* captured group to the start of
    //     the current captured group is appended to the *current* segment
    //     (trailing part of the previous match plus leading part of this match).
    //
    // A simpler approach that matches most real-world configs:
    //   Split on the captured group.  The regex overall matches a region;
    //   the captured group within that region is what gets removed.

    // To split correctly we iterate matches ourselves, over the WHOLE input
    // with `lastIndex` rather than over a re-sliced remainder. Re-slicing hid
    // the text already consumed from a lookbehind — `(?<=\})(\n)` could never
    // see the `}` that ended the previous event — and copied the tail of the
    // input once per event, which is quadratic on a large sample (#283).
    // Use 'd' flag so RegExpExecArray.indices gives exact capture offsets,
    // avoiding the indexOf() ambiguity when captured text repeats in the match.
    const lineBreakerRegex = safeRegex(lineBreakerPattern, 'dg');
    if (!lineBreakerRegex) {
      // Invalid regex — treat entire data as one segment. A user-supplied
      // LINE_BREAKER that fails to compile silently disables event breaking, so
      // surface it (the default '([\r\n]+)' always compiles, so this is a real config).
      if (diagnostics && getDirective(directives, 'LINE_BREAKER') !== undefined) {
        diagnostics.push({
          level: 'warning',
          message: `LINE_BREAKER pattern (${lineBreakerPattern}) could not be compiled safely (invalid regex or rejected as ReDoS-prone). Event breaking was skipped — the entire input is treated as one event.`,
          file: 'props.conf',
          ...atDirective(effectiveDirective(directives, 'LINE_BREAKER')),
        });
      }
      segments = [rawData];
      segmentOffsets.push(0);
    } else {
      // `segmentStart` is where the event being built begins; `searchFrom` is
      // where the next search starts. They differ only after a zero-width
      // break was refused, below.
      let segmentStart = 0;
      let searchFrom = 0;

      while (searchFrom <= rawData.length) {
        lineBreakerRegex.lastIndex = searchFrom;
        const m = lineBreakerRegex.exec(rawData);
        if (!m) break;

        // The captured group is the separator to discard. A match in which the
        // group did not participate (`(a)|b` matching `b`) has no group
        // offsets, so the whole match stands in for it.
        const groupIndices = m[1] !== undefined ? m.indices?.[1] : undefined;
        const captureStart = groupIndices ? groupIndices[0] : m.index;
        const captureEnd = groupIndices ? groupIndices[1] : m.index + m[0].length;

        // A break that would not move the event start forward is no break: an
        // empty capture at the start of the current event (`()(?=b)` just
        // after a previous break) would otherwise end an empty event there, and
        // the old guard then emitted the next character as an event of its own
        // (`bcd` came out as `b` + `cd`). Retry one character further on, which
        // is where the next genuine break can begin (#283).
        if (captureEnd <= segmentStart) {
          searchFrom = m.index + 1;
          continue;
        }

        // Segment text = everything before the captured group
        const segmentText = rawData.slice(segmentStart, Math.max(captureStart, segmentStart));
        if (segmentText.length > 0 || segments.length === 0) {
          segments.push(segmentText);
          segmentOffsets.push(segmentStart);
        }

        // Advance past the captured group.  Any text between the end of the
        // captured group and the end of the full match becomes the start of
        // the next segment, and is searched again for the next break.
        segmentStart = captureEnd;
        searchFrom = captureEnd;
      }

      if (segmentStart < rawData.length) {
        segments.push(rawData.slice(segmentStart));
        segmentOffsets.push(segmentStart);
      }
    }
  }

  // Filter out empty segments
  const filteredSegments: { text: string; offset: number }[] = [];
  for (const [i, text] of segments.entries()) {
    if (text.length > 0) {
      filteredSegments.push({ text, offset: segmentOffsets[i] ?? 0 });
    }
  }

  const [firstSegment, ...restSegments] = filteredSegments;
  if (firstSegment === undefined) {
    return [];
  }

  // ── Step 2: SHOULD_LINEMERGE ──────────────────────────────────────
  const shouldLineMergeVal = getDirective(directives, 'SHOULD_LINEMERGE');
  // SHOULD_LINEMERGE defaults to true, EXCEPT when INDEXED_EXTRACTIONS is set:
  // structured formats are one record per line, so merging would hand the
  // extractor several records glued together. For JSON that is not a subtle
  // error — `JSON.parse` of two concatenated objects throws, so the whole event
  // extracted nothing and #164 read as "INDEXED_EXTRACTIONS = JSON is not
  // implemented" when the extractor was never given a parseable event.
  // An explicit SHOULD_LINEMERGE still wins, as it does in Splunk.
  //
  // The XML modes are the exception (#271): an XML record is a document, and
  // routinely spans lines. Splitting it per line hands the extractor a string
  // of fragments, none of which parse, and ignores the BREAK_ONLY_BEFORE the
  // user wrote to frame the record. They keep the ordinary default.
  const structuredFormat = getDirective(directives, 'INDEXED_EXTRACTIONS')?.trim().toLowerCase();
  const structured =
    structuredFormat !== undefined && structuredFormat !== '' && structuredFormat !== 'none' &&
    !XML_EXTRACTIONS.has(structuredFormat);
  const shouldLineMerge =
    // An explicit value that is not a boolean reads as false, as it always has
    // here; it is the structured-format default that only an absent key gets.
    shouldLineMergeVal === undefined ? !structured : parseSplunkBool(shouldLineMergeVal, false);

  // `lines` is the length of each LINE_BREAKER segment the event was built
  // from, in order; see segmentLengthsOf.
  let mergedSegments: { text: string; offset: number; lines: number[] }[];
  let maxEventsTriggered = false;

  if (!shouldLineMerge) {
    mergedSegments = filteredSegments.map((seg) => ({ ...seg, lines: [seg.text.length] }));
  } else {
    // Merge directives
    const breakOnlyBeforeStr = getDirective(directives, 'BREAK_ONLY_BEFORE');
    const breakOnlyBeforeDateStr = getDirective(directives, 'BREAK_ONLY_BEFORE_DATE');
    const mustBreakAfterStr = getDirective(directives, 'MUST_BREAK_AFTER');

    // Splunk matches BREAK_ONLY_BEFORE at the start of each segment (line-anchored).
    const breakOnlyBeforeAnchoredRegex = breakOnlyBeforeStr
      ? safeRegex('^(?:' + breakOnlyBeforeStr + ')')
      : null;
    // A pattern that will not compile silently drops the option and falls back to
    // date-only breaking, changing every event boundary with no indication why.
    // LINE_BREAKER already warns in the same situation; these must too.
    warnUncompilableBreakPattern(
      'BREAK_ONLY_BEFORE', breakOnlyBeforeStr, breakOnlyBeforeAnchoredRegex, directives, diagnostics,
    );
    // Splunk default: BREAK_ONLY_BEFORE_DATE=true when SHOULD_LINEMERGE=true.
    // Only disabled when explicitly set to a false spelling.
    const breakOnlyBeforeDate = parseSplunkBool(breakOnlyBeforeDateStr, true);
    // Read exactly as timestampExtractor reads it, so the window a date is
    // looked for in here is the one the extractor will then parse it from.
    const lookaheadStr = getDirective(directives, 'MAX_TIMESTAMP_LOOKAHEAD');
    const parsedLookahead = lookaheadStr !== undefined ? parseInt(lookaheadStr.trim(), 10) : DEFAULT_TIMESTAMP_LOOKAHEAD;
    const timestampLookahead =
      Number.isFinite(parsedLookahead) && parsedLookahead > 0 ? parsedLookahead : DEFAULT_TIMESTAMP_LOOKAHEAD;
    const mustBreakAfterRegex = mustBreakAfterStr
      ? safeRegex(mustBreakAfterStr)
      : null;
    warnUncompilableBreakPattern(
      'MUST_BREAK_AFTER', mustBreakAfterStr, mustBreakAfterRegex, directives, diagnostics,
    );

    // The negative half of the merging rules (#190). MUST_NOT_BREAK_BEFORE is
    // deliberately NOT read: three captures (linebreak-must-not-break-before,
    // -explicit, -forced) measure Splunk 10.4.0 breaking anyway against a
    // date rule, BREAK_ONLY_BEFORE, and a MUST_BREAK_AFTER-forced break — the
    // spec sentence describes a suppression no observable configuration
    // exhibits, so the faithful simulation is no effect at all.
    const mustNotBreakAfterStr = getDirective(directives, 'MUST_NOT_BREAK_AFTER');
    const mustNotBreakAfterRegex = mustNotBreakAfterStr ? safeRegex(mustNotBreakAfterStr) : null;
    warnUncompilableBreakPattern(
      'MUST_NOT_BREAK_AFTER', mustNotBreakAfterStr, mustNotBreakAfterRegex, directives, diagnostics,
    );

    // MAX_EVENTS caps how many CONTINUATION lines may be merged into an event,
    // not how many lines the event may total: MAX_EVENTS = 3 produces a
    // four-line event, as the `linebreak-max-events` capture records. Reading it
    // as a total broke one line early (#162).
    const maxEventsStr = getDirective(directives, 'MAX_EVENTS');
    const parsedMaxEvents = maxEventsStr !== undefined ? parseInt(maxEventsStr.trim(), 10) : 256;
    const maxContinuationLines =
      Number.isFinite(parsedMaxEvents) && parsedMaxEvents > 0 ? parsedMaxEvents : 256;
    const maxEvents = maxContinuationLines + 1;

    // MUST_BREAK_AFTER adds a mandatory break; it does not license merging up to
    // that break. When it is the ONLY rule in force — BREAK_ONLY_BEFORE absent
    // and BREAK_ONLY_BEFORE_DATE explicitly false — Splunk has no rule saying
    // when to continue an event, so it breaks on every line. The engine instead
    // read MUST_BREAK_AFTER as the sole break rule and merged up to each match,
    // producing 2 events where Splunk produces 6 (#161).
    //
    // Deliberately narrow: with no MUST_BREAK_AFTER either, merging still
    // happens as before (bounded by MAX_EVENTS), which is what Splunk documents
    // and what no capture contradicts.
    const canMerge =
      breakOnlyBeforeAnchoredRegex !== null || breakOnlyBeforeDate || mustBreakAfterRegex === null;

    mergedSegments = [{ ...firstSegment, lines: [firstSegment.text.length] }];
    let currentLineCount = countLines(firstSegment.text);
    let forceBreakNext = false;
    // MUST_NOT_BREAK_AFTER is stateful: once a line matches, rule-driven breaks
    // stay suppressed until a line matches MUST_BREAK_AFTER. Without one, the
    // suppression runs to the end of the input.
    let suppressBreaks = mustNotBreakAfterRegex !== null && mustNotBreakAfterRegex.test(firstSegment.text);

    // Check if the very first segment triggers MUST_BREAK_AFTER
    if (mustBreakAfterRegex && mustBreakAfterRegex.test(firstSegment.text)) {
      forceBreakNext = true;
    }

    for (const seg of restSegments) {
      const segLines = countLines(seg.text);

      // Decide the break and remember WHICH rule asked for it, because the rule
      // decides whether a veto can stand against it. Precedence between the
      // positive rules is unchanged; the vetoes are applied afterwards.
      const overCap = currentLineCount + segLines > maxEvents;
      const bobBreak =
        breakOnlyBeforeAnchoredRegex !== null && breakOnlyBeforeAnchoredRegex.test(seg.text);
      const dateBreak =
        breakOnlyBeforeDate && lineHasDate(seg.text, timestampLookahead);

      let reason:
        | 'must-break-after'
        | 'no-merge-rule'
        | 'max-events'
        | 'break-only-before'
        | 'date'
        | null = null;
      if (forceBreakNext) reason = 'must-break-after';
      else if (!canMerge) reason = 'no-merge-rule';
      else if (overCap) reason = 'max-events';
      else if (bobBreak) reason = 'break-only-before';
      else if (dateBreak) reason = 'date';
      forceBreakNext = false;

      // MUST_NOT_BREAK_AFTER suppression (#190): every rule-driven break is
      // suppressed until MUST_BREAK_AFTER matches, exactly the stateful span
      // the capture `linebreak-must-not-break-after-span` records — dated
      // lines inside the span stay merged. MAX_EVENTS is a hard cap the
      // suppression does not defeat.
      if (reason !== null && reason !== 'max-events' && suppressBreaks) {
        reason = overCap ? 'max-events' : null;
      }
      if (reason === 'max-events') maxEventsTriggered = true;

      if (reason !== null) {
        mergedSegments.push({ text: seg.text, offset: seg.offset, lines: [seg.text.length] });
        currentLineCount = segLines;
      } else {
        // Merge into previous
        const prev = mergedSegments.at(-1);
        if (prev !== undefined) {
          prev.text += '\n' + seg.text;
          prev.lines.push(seg.text.length);
        }
        currentLineCount += segLines;
      }

      // MUST_BREAK_AFTER both forces a break after a matching line and ends a
      // MUST_NOT_BREAK_AFTER suppression; a line matching MUST_NOT_BREAK_AFTER
      // (re)starts one from the next line on.
      if (mustBreakAfterRegex) {
        if (mustBreakAfterRegex.test(seg.text)) {
          if (suppressBreaks) suppressBreaks = false;
          forceBreakNext = true;
        } else {
          forceBreakNext = false;
        }
      }
      if (mustNotBreakAfterRegex && mustNotBreakAfterRegex.test(seg.text)) {
        suppressBreaks = true;
      }
    }
  }

  // ── Step 3: Create SplunkEvent objects ────────────────────────────
  const newlines = buildNewlineIndex(rawData);
  const events: SplunkEvent[] = mergedSegments.map((seg) => {
    const lineNums = {
      start: lineAtOffset(newlines, seg.offset),
      end: lineAtOffset(newlines, seg.offset + seg.text.length),
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
  });

  // Add a summary trace entry if merging occurred
  if (shouldLineMerge && filteredSegments.length !== mergedSegments.length) {
    const mergeInfo: string[] = [];
    if (getDirective(directives, 'BREAK_ONLY_BEFORE')) {
      mergeInfo.push(`BREAK_ONLY_BEFORE=${getDirective(directives, 'BREAK_ONLY_BEFORE')}`);
    }
    if (getDirective(directives, 'BREAK_ONLY_BEFORE_DATE')) {
      mergeInfo.push(`BREAK_ONLY_BEFORE_DATE=${getDirective(directives, 'BREAK_ONLY_BEFORE_DATE')}`);
    }
    if (getDirective(directives, 'MUST_BREAK_AFTER')) {
      mergeInfo.push(`MUST_BREAK_AFTER=${getDirective(directives, 'MUST_BREAK_AFTER')}`);
    }
    if (getDirective(directives, 'MUST_NOT_BREAK_AFTER')) {
      mergeInfo.push(`MUST_NOT_BREAK_AFTER=${getDirective(directives, 'MUST_NOT_BREAK_AFTER')}`);
    }
    if (maxEventsTriggered) {
      mergeInfo.push(`MAX_EVENTS=${getDirective(directives, 'MAX_EVENTS') ?? '256'} (line cap forced a break)`);
    }
    for (const ev of events) {
      ev.processingTrace.push({
        processor: 'lineBreaker',
        phase: 'index-time',
        description:
          `SHOULD_LINEMERGE=true merged ${filteredSegments.length} segments into ${mergedSegments.length} events` +
          (mergeInfo.length > 0 ? ` (${mergeInfo.join(', ')})` : ''),
        fieldsAdded: [],
        fieldsModified: [],
      });
    }
  }

  return events;
}
