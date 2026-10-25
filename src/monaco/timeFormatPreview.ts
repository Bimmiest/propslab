// ---------------------------------------------------------------------------
// timeFormatPreview.ts
// Make a TIME_FORMAT explain itself in the editor.
//
// Timestamp configuration is the most error-prone part of props.conf, and its
// failure is silent: a typo'd specifier yields "no _time" with nothing said
// about which specifier, or where. The preview answers three questions without
// leaving the editor — what does this pattern produce, does it match my data,
// and is there anything in it the simulator will not honour.
// ---------------------------------------------------------------------------

import { formatStrftime, strftimeToRegex, unsupportedSpecifiers } from '../utils/strftime';
import { validateRegex } from '../utils/splunkRegex';
import { escapeMarkdown, inlineCode } from './markdown';
import { matchTimePrefix, TIME_PREFIX_TIMEOUT_MS } from './timePrefixMatcher';
import type { CancellationLike, PrefixMatcher } from './timePrefixMatcher';

/**
 * The most of the sample line the preview will search.
 *
 * TIME_PREFIX and TIME_FORMAT run in a terminatable worker, so this cap is not
 * what bounds a runaway pattern. It bounds what is copied to the worker. The
 * engine cannot share this bound (it searches the whole event), and a prefix
 * that only matches beyond 4 KB into the first line is not a case this preview
 * needs to get right.
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
    /** TIME_PREFIX was not run: it does not compile. */
    | { status: 'prefix-refused'; reason: string }
    /** TIME_PREFIX ran past the watchdog and its worker was terminated. */
    | { status: 'prefix-timed-out'; timeoutMs: number }
    /** TIME_PREFIX ran and threw. */
    | { status: 'prefix-error'; reason: string }
    | null;
  unsupported: { specifier: string; index: number }[];
}

export interface TimeFormatPreviewOptions {
  now?: Date;
  sampleLine?: string;
  timePrefix?: string;
  /** Honoured while TIME_PREFIX is in the worker: a cancelled preview resolves to null. */
  token?: CancellationLike;
  /** Where TIME_PREFIX is matched. Defaults to the shared worker; tests inject one. */
  matchPrefix?: PrefixMatcher;
}

/** `attemptSample` gave up: the caller cancelled, or there was no worker to ask. */
const CANCELLED = Symbol('cancelled');
const OMITTED = Symbol('omitted');

/**
 * Try `format` against `sampleLine`, honouring TIME_PREFIX the way
 * `timestampExtractor` does — the preview is worthless if it answers a
 * different question from the engine.
 */
async function attemptSample(
  format: string,
  fullSampleLine: string,
  timePrefix: string | undefined,
  matchPrefix: PrefixMatcher,
  token: CancellationLike | undefined,
): Promise<TimeFormatPreview['sample'] | typeof CANCELLED | typeof OMITTED> {
  const sampleLine = fullSampleLine.slice(0, MAX_PREVIEW_SAMPLE_LENGTH);
  if (timePrefix) {
    // Compiled here by the engine's own PCRE2, so a pattern the engine would
    // refuse is reported with its reason and never sent anywhere. Compiling
    // does not execute it.
    const refusal = validateRegex(timePrefix);
    if (refusal !== null) return { status: 'prefix-refused', reason: refusal };
  }
  // Generating the format's regex runs nothing either; one that cannot be
  // generated matches nothing, as in the engine.
  try {
    strftimeToRegex(format);
  } catch {
    return { status: 'no-match', searchedFrom: 0 };
  }

  // Both matches happen only in the worker, on the same engine and with the
  // same anchoring rule, so it previews the way it extracts.
  const outcome = await matchPrefix(timePrefix || undefined, sampleLine, token, format);
  switch (outcome.status) {
    case 'cancelled':
      return CANCELLED;
    case 'unavailable':
      return OMITTED;
    case 'timed-out':
      return { status: 'prefix-timed-out', timeoutMs: TIME_PREFIX_TIMEOUT_MS };
    case 'error':
      return { status: 'prefix-error', reason: outcome.message };
    case 'no-match':
      return { status: 'no-match', searchedFrom: 0 };
    case 'matched': {
      const found = outcome.format;
      if (!found) return { status: 'no-match', searchedFrom: outcome.end };
      return found.parsedMs === null
        ? { status: 'unparseable', text: found.text }
        : { status: 'matched', text: found.text, iso: new Date(found.parsedMs).toISOString() };
    }
  }
}

/**
 * The parts of the preview that need no sample line — what the pattern renders
 * as, and what it contains that the simulator will not honour. Synchronous,
 * for the completion detail, which runs no user regex at all.
 */
export function describeTimeFormat(format: string, now: Date = new Date()): TimeFormatPreview {
  const trimmed = format.trim();
  if (trimmed === '') {
    return { rendered: null, sample: null, unsupported: [] };
  }

  let rendered: string | null;
  try {
    rendered = formatStrftime(now, trimmed);
  } catch {
    // An unrenderable pattern is still worth reporting on for its specifiers.
    rendered = null;
  }
  return { rendered, sample: null, unsupported: unsupportedSpecifiers(trimmed) };
}

/**
 * The full preview, including the sample line. Asynchronous because a
 * TIME_PREFIX is matched in a worker. Resolves to null when
 * `options.token` is cancelled before that returns. When no worker is
 * available the sample is omitted (`sample: null`) rather than matched on
 * this thread.
 */
export async function buildTimeFormatPreview(
  format: string,
  options: TimeFormatPreviewOptions = {},
): Promise<TimeFormatPreview | null> {
  const preview = describeTimeFormat(format, options.now);
  const trimmed = format.trim();
  if (trimmed === '' || options.sampleLine === undefined || options.sampleLine === '') {
    return preview;
  }

  const attempted = await attemptSample(
    trimmed,
    options.sampleLine,
    options.timePrefix,
    options.matchPrefix ?? matchTimePrefix,
    options.token,
  );
  if (attempted === CANCELLED) return null;
  return { ...preview, sample: attempted === OMITTED ? null : attempted };
}

/**
 * Markdown for a hover or a completion detail. Empty when there is nothing to say.
 *
 * `rendered` carries the format's literal text and `sample.text` is event data,
 * both user-authored, so each goes through `inlineCode` rather than a bare pair
 * of backticks a stray backtick could close.
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
        parts.push(`**Sample:** not tried — TIME_PREFIX was not run: ${escapeMarkdown(preview.sample.reason)}`);
        break;
      case 'prefix-timed-out':
        parts.push(
          `**Sample:** preview timed out — matching TIME_PREFIX and TIME_FORMAT against the sample line ran for over ${preview.sample.timeoutMs / 1000} s and was stopped.`,
        );
        break;
      case 'prefix-error':
        parts.push(`**Sample:** not tried — matching the sample line failed: ${escapeMarkdown(preview.sample.reason)}`);
        break;
    }
  }

  if (preview.unsupported.length > 0) {
    const list = preview.unsupported.map((u) => `${inlineCode(u.specifier)} (offset ${u.index})`).join(', ');
    parts.push(`**Not simulated:** ${list} — the preview treats these as literal text.`);
  }

  return parts.join('\n\n');
}
