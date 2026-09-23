// ---------------------------------------------------------------------------
// timeFormatPreview.ts
// Make a TIME_FORMAT explain itself in the editor (#90).
//
// Timestamp configuration is the most error-prone part of props.conf, and its
// failure is silent: a typo'd specifier yields "no _time" with nothing said
// about which specifier, or where. The preview answers three questions without
// leaving the editor — what does this pattern produce, does it match my data,
// and is there anything in it the simulator will not honour.
// ---------------------------------------------------------------------------

import { formatStrftime, strftimeToRegex, parseTimestamp, unsupportedSpecifiers } from '../utils/strftime';
import { safeRegex, validateRegex } from '../utils/splunkRegex';
import { escapeMarkdown, inlineCode } from './markdown';

/**
 * The most of the sample line the preview will search (#297).
 *
 * The hover runs on the main thread, with none of the worker watchdogs that
 * guard the pipeline, so the TIME_PREFIX match is the one user regex in the
 * editor that could freeze the tab. `safeRegex` refuses the structurally
 * catastrophic shapes, but it is a heuristic — `(a|aa)+` slips past it — and
 * the other half of the defence is input length: backtracking cost grows with
 * the text, and 4 KB keeps even a polynomial blow-up to a stutter. The engine
 * cannot share this bound (it searches the whole event, off-thread), and a
 * prefix that only matches beyond 4 KB into the first line is not a case this
 * preview needs to get right.
 */
export const MAX_PREVIEW_SAMPLE_LENGTH = 4096;

export interface TimeFormatPreview {
  /** The current time rendered with this pattern — "what does this produce?". */
  rendered: string | null;
  /** Result of trying the pattern against a sample line, when one was given. */
  sample:
    | { status: 'matched'; text: string; iso: string }
    | { status: 'no-match'; searchedFrom: number }
    | { status: 'unparseable'; text: string }
    /** TIME_PREFIX was not run: it is invalid, or refused as ReDoS-prone. */
    | { status: 'prefix-refused'; reason: string }
    | null;
  unsupported: { specifier: string; index: number }[];
}

/**
 * Try `format` against `sampleLine`, honouring TIME_PREFIX the way
 * `timestampExtractor` does — the preview is worthless if it answers a
 * different question from the engine.
 */
function attemptSample(
  format: string,
  fullSampleLine: string,
  timePrefix: string | undefined,
): TimeFormatPreview['sample'] {
  const sampleLine = fullSampleLine.slice(0, MAX_PREVIEW_SAMPLE_LENGTH);
  let searchStart = 0;
  if (timePrefix) {
    // Compiled exactly as the engine compiles it — PCRE translated, ReDoS
    // guard applied — so `(?i)ts=` or `(?P<p>…)` previews the way it
    // extracts, and a pattern the engine would refuse is never run here.
    // `validateRegex` applies the same translation and guard, and says why.
    const refusal = validateRegex(timePrefix);
    const prefixRegex = refusal === null ? safeRegex(timePrefix) : null;
    if (!prefixRegex) {
      return { status: 'prefix-refused', reason: refusal ?? 'the pattern could not be compiled' };
    }
    const prefixMatch = prefixRegex.exec(sampleLine);
    if (!prefixMatch) return { status: 'no-match', searchedFrom: 0 };
    searchStart = prefixMatch.index + prefixMatch[0].length;
  }

  const region = sampleLine.slice(searchStart);
  let formatRegex: RegExp;
  try {
    formatRegex = strftimeToRegex(format);
  } catch {
    return { status: 'no-match', searchedFrom: searchStart };
  }

  // With a prefix the format must sit immediately after it, matching the
  // engine's anchoring rule (#66).
  const active = timePrefix
    ? new RegExp(`^\\s*(?:${formatRegex.source})`, formatRegex.flags)
    : formatRegex;

  const match = active.exec(region);
  if (!match) return { status: 'no-match', searchedFrom: searchStart };

  const parsed = parseTimestamp(match[0], format);
  return parsed
    ? { status: 'matched', text: match[0], iso: parsed.toISOString() }
    : { status: 'unparseable', text: match[0] };
}

export function buildTimeFormatPreview(
  format: string,
  options: { now?: Date; sampleLine?: string; timePrefix?: string } = {},
): TimeFormatPreview {
  const trimmed = format.trim();
  if (trimmed === '') {
    return { rendered: null, sample: null, unsupported: [] };
  }

  let rendered: string | null;
  try {
    rendered = formatStrftime(options.now ?? new Date(), trimmed);
  } catch {
    // An unrenderable pattern is still worth reporting on for its specifiers.
    rendered = null;
  }

  return {
    rendered,
    sample:
      options.sampleLine !== undefined && options.sampleLine !== ''
        ? attemptSample(trimmed, options.sampleLine, options.timePrefix)
        : null,
    unsupported: unsupportedSpecifiers(trimmed),
  };
}

/**
 * Markdown for a hover or a completion detail. Empty when there is nothing to say.
 *
 * `rendered` carries the format's literal text and `sample.text` is event data,
 * both user-authored, so each goes through `inlineCode` rather than a bare pair
 * of backticks a stray backtick could close (#296).
 */
export function renderTimeFormatPreview(preview: TimeFormatPreview): string {
  const parts: string[] = [];

  if (preview.rendered !== null) {
    parts.push(`**Now:** ${inlineCode(preview.rendered)}`);
  }

  if (preview.sample) {
    switch (preview.sample.status) {
      case 'matched':
        parts.push(`**Sample:** matched ${inlineCode(preview.sample.text)} → ${inlineCode(preview.sample.iso)}`);
        break;
      case 'unparseable':
        parts.push(
          `**Sample:** matched ${inlineCode(preview.sample.text)}, but it could not be assembled into a date — check the field order and ranges.`,
        );
        break;
      case 'no-match':
        parts.push(
          preview.sample.searchedFrom > 0
            ? `**Sample:** no match at offset ${preview.sample.searchedFrom} (immediately after TIME_PREFIX).`
            : '**Sample:** no match in the first event line.',
        );
        break;
      case 'prefix-refused':
        // The reason can quote the pattern (a SyntaxError message does), so it
        // is document text like any other.
        parts.push(
          `**Sample:** not tried — TIME_PREFIX was not run: ${escapeMarkdown(preview.sample.reason)}`,
        );
        break;
    }
  }

  if (preview.unsupported.length > 0) {
    const list = preview.unsupported.map((u) => `${inlineCode(u.specifier)} (offset ${u.index})`).join(', ');
    parts.push(`**Not simulated:** ${list} — the preview treats these as literal text.`);
  }

  return parts.join('\n\n');
}
