// ---------------------------------------------------------------------------
// timeFormatPreview.test.ts
// The TIME_FORMAT live preview.
//
// The sample-line assertions are the ones with teeth: a preview that answers a
// different question from the pipeline is worse than none, because it tells you
// your format works when the engine will not match it.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { marked } from 'marked';
import {
  buildTimeFormatPreview as buildWith,
  describeTimeFormat,
  renderTimeFormatPreview,
  MAX_PREVIEW_SAMPLE_LENGTH,
  type TimeFormatPreview,
  type TimeFormatPreviewOptions,
} from '../timeFormatPreview';
import { TIME_PREFIX_TIMEOUT_MS, type PrefixMatchOutcome, type PrefixMatcher } from '../timePrefixMatcher';
import { probeTimestamps } from '../../engine/timestampMatch';
import { unsupportedSpecifiers } from '../../utils/strftime';

/**
 * Stands in for the worker by running what the worker runs — the Timestamp
 * prober, over the whole sample — so these tests still pin the preview to the
 * engine's reading of TIME_PREFIX and TIME_FORMAT. The worker plumbing itself
 * is covered in timePrefixMatcher.test.ts.
 */
const proberInline: PrefixMatcher = (pattern, sample, _token, timeFormat) => {
  const [probe] = probeTimestamps([sample], {
    timePrefix: pattern ?? null,
    timeFormat: timeFormat ?? null,
    maxLookahead: timeFormat === undefined ? 0 : sample.length,
    tz: null,
  });
  if (pattern !== undefined && !probe?.prefix) return Promise.resolve({ status: 'no-match' });
  const match = probe?.match ?? null;
  return Promise.resolve({
    status: 'matched',
    end: probe?.prefix?.end ?? 0,
    ...(timeFormat !== undefined ? { format: match && { text: match.matchedText, parsedMs: match.parsedTimeMs } } : {}),
  });
};

/** A worker stand-in that gives one answer, whatever it is asked. */
const answering =
  (outcome: PrefixMatchOutcome): PrefixMatcher =>
  () =>
    Promise.resolve(outcome);

/** A worker stand-in that records each request, for the tests that must send none. */
function recording() {
  const asked: { sample: string; timeFormat: string | undefined }[] = [];
  const matchPrefix: PrefixMatcher = (_pattern, sample, _token, timeFormat) => {
    asked.push({ sample, timeFormat });
    return Promise.resolve({ status: 'no-match' });
  };
  return { asked, matchPrefix };
}

async function buildTimeFormatPreview(
  format: string,
  options: TimeFormatPreviewOptions = {},
): Promise<TimeFormatPreview> {
  const preview = await buildWith(format, { matchPrefix: proberInline, ...options });
  if (preview === null) throw new Error('unexpectedly cancelled');
  return preview;
}

// Local time, not UTC: the preview renders the current time the way the
// user's clock reads it (formatStrftime uses the local accessors), so this is
// the instant that renders as 2026-08-04 12:30:45 on any machine (#407).
const NOW = new Date(2026, 7, 4, 12, 30, 45);

describe('unsupportedSpecifiers', () => {
  it('accepts a format built entirely from supported specifiers', () => {
    expect(unsupportedSpecifiers('%Y-%m-%dT%H:%M:%S')).toEqual([]);
  });

  it('accepts the expanded and escaped forms', () => {
    expect(unsupportedSpecifiers('%F %T %%')).toEqual([]);
  });

  it('accepts sub-second widths', () => {
    expect(unsupportedSpecifiers('%H:%M:%S.%3N')).toEqual([]);
    expect(unsupportedSpecifiers('%H:%M:%S.%6N')).toEqual([]);
  });

  it('accepts the colon offsets and the %Q widths the parser reads (#429)', () => {
    expect(unsupportedSpecifiers('%F %T %:z %::z')).toEqual([]);
    expect(unsupportedSpecifiers('%3Q %6Q %9Q %Q %N %f %k %l')).toEqual([]);
  });

  it('flags specifiers the parser does not read, which strftime leaves literal (#429)', () => {
    expect(unsupportedSpecifiers('%c %w %0N')).toEqual([
      { specifier: '%c', index: 0 },
      { specifier: '%w', index: 3 },
      { specifier: '%0N', index: 6 },
    ]);
  });

  it('flags a specifier from another language, with its offset', () => {
    // %i is MySQL's minutes; strftime has no such specifier, and treating the
    // literal `i` as text is how this survives into production.
    expect(unsupportedSpecifiers('%Y-%m-%d %H:%i')).toEqual([{ specifier: '%i', index: 12 }]);
  });

  it('flags a trailing bare percent', () => {
    expect(unsupportedSpecifiers('%Y-%m-%d %')).toEqual([{ specifier: '%', index: 9 }]);
  });
});

describe('buildTimeFormatPreview', () => {
  it('renders the current time with the pattern', async () => {
    const preview = await buildTimeFormatPreview('%Y-%m-%d', { now: NOW });
    expect(preview.rendered).toBe('2026-08-04');
  });

  it('says nothing at all for an empty value', async () => {
    const preview = await buildTimeFormatPreview('   ', { now: NOW });
    expect(preview.rendered).toBeNull();
    expect(renderTimeFormatPreview(preview)).toBe('');
  });

  it('matches a sample line and resolves it', async () => {
    const preview = await buildTimeFormatPreview('%Y-%m-%d %H:%M:%S', {
      now: NOW,
      sampleLine: '2024-01-15 10:00:00 user=alice',
    });
    expect(preview.sample).toEqual({
      status: 'matched',
      text: '2024-01-15 10:00:00',
      iso: '2024-01-15T10:00:00.000Z',
    });
  });

  it("previews splunkd.log's %l as milliseconds, as the engine reads it (#578)", async () => {
    const preview = await buildTimeFormatPreview('%m-%d-%Y %H:%M:%S.%l %z', {
      now: NOW,
      sampleLine: '10-06-2026 15:30:00.282 +0000 WARN AdminManager - Could not find object',
    });
    expect(preview.sample).toEqual({
      status: 'matched',
      text: '10-06-2026 15:30:00.282 +0000',
      iso: '2026-10-06T15:30:00.282Z',
    });
  });

  it('reports a sample that has the shape of the format but is not a date', async () => {
    // February has no 30th. The text matches the format, but no instant can be
    // assembled from it, and the engine leaves the event with no _time.
    const preview = await buildTimeFormatPreview('%Y-%m-%d', { now: NOW, sampleLine: '2024-02-30 user=alice' });
    expect(preview.sample).toEqual({ status: 'unparseable', text: '2024-02-30' });
  });

  it('trims the format before it matches the sample', async () => {
    // Untrimmed, each outer space would ask for whitespace around the date.
    const preview = await buildTimeFormatPreview('  %Y-%m-%d  ', { now: NOW, sampleLine: '2024-01-15 user=alice' });
    expect(preview).toEqual({
      rendered: '2026-08-04',
      sample: { status: 'matched', text: '2024-01-15', iso: '2024-01-15T00:00:00.000Z' },
      unsupported: [],
    });
  });

  it('sends nothing to the worker for a blank format or an empty sample line', async () => {
    const { asked, matchPrefix } = recording();
    const blank = await buildTimeFormatPreview('   ', { now: NOW, sampleLine: '2024-01-15', matchPrefix });
    expect(blank).toEqual({ rendered: null, sample: null, unsupported: [] });
    const noSample = await buildTimeFormatPreview('%Y-%m-%d', { now: NOW, sampleLine: '', matchPrefix });
    expect(noSample).toEqual({ rendered: '2026-08-04', sample: null, unsupported: [] });
    expect(asked).toEqual([]);
  });

  it('matches nothing, and sends nothing to the worker, for a format that gives no regex', async () => {
    // Each %d is a capture group, and a JavaScript regex accepts at most 32,767
    // of them. The engine matches nothing with such a format, so the preview
    // says the same without a round trip.
    const { asked, matchPrefix } = recording();
    const preview = await buildTimeFormatPreview('%d'.repeat(32_768), { now: NOW, sampleLine: '15', matchPrefix });
    expect(preview.sample).toEqual({ status: 'no-match', searchedFrom: 0 });
    expect(asked).toEqual([]);
  });

  describe('what the worker answers', () => {
    it('resolves to null when the caller cancels while the worker matches', async () => {
      const preview = await buildWith('%Y-%m-%d', {
        now: NOW,
        sampleLine: '2024-01-15',
        matchPrefix: answering({ status: 'cancelled' }),
      });
      expect(preview).toBeNull();
    });

    it('omits the sample, and keeps the rest, when there is no worker to ask', async () => {
      const preview = await buildTimeFormatPreview('%Y-%m-%d %H:%i', {
        now: NOW,
        sampleLine: '2024-01-15',
        matchPrefix: answering({ status: 'unavailable' }),
      });
      expect(preview).toEqual({
        rendered: '2026-08-04 12:%i',
        sample: null,
        unsupported: [{ specifier: '%i', index: 12 }],
      });
    });

    it('reports the error the worker raised, as an error and not as no match', async () => {
      const preview = await buildTimeFormatPreview('%Y-%m-%d', {
        now: NOW,
        sampleLine: '2024-01-15',
        timePrefix: 'ts=',
        matchPrefix: answering({ status: 'error', message: 'No events to probe' }),
      });
      expect(preview.sample).toEqual({ status: 'prefix-error', reason: 'No events to probe' });
    });

    it('reports a run the watchdog stopped, with the budget it had', async () => {
      const preview = await buildTimeFormatPreview('%Y-%m-%d', {
        now: NOW,
        sampleLine: '2024-01-15',
        timePrefix: 'ts=',
        matchPrefix: answering({ status: 'timed-out' }),
      });
      expect(preview.sample).toEqual({ status: 'prefix-timed-out', timeoutMs: TIME_PREFIX_TIMEOUT_MS });
    });
  });

  it('reports a sample that does not match', async () => {
    const preview = await buildTimeFormatPreview('%Y/%m/%d', {
      now: NOW,
      sampleLine: '2024-01-15 10:00:00 user=alice',
    });
    expect(preview.sample?.status).toBe('no-match');
  });

  it('honours TIME_PREFIX the way the engine does', async () => {
    const preview = await buildTimeFormatPreview('%Y-%m-%dT%H:%M:%S', {
      now: NOW,
      sampleLine: 'id=5 ts=2024-01-15T10:00:00 rest',
      timePrefix: 'ts=',
    });
    expect(preview.sample).toMatchObject({ status: 'matched', text: '2024-01-15T10:00:00' });
  });

  it('anchors after TIME_PREFIX rather than scanning the whole line (#66)', async () => {
    // The date is present but NOT immediately after the prefix, which is what a
    // real indexer refuses — so the preview must refuse it too.
    const preview = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: 'ts=pending job started 2024-01-15',
      timePrefix: 'ts=',
    });
    expect(preview.sample?.status).toBe('no-match');
  });

  it('reports where it started looking when a prefix moved the search', async () => {
    const preview = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: 'ts=nothing here',
      timePrefix: 'ts=',
    });
    expect(preview.sample).toEqual({ status: 'no-match', searchedFrom: 3 });
  });

  it('reports a TIME_PREFIX that does not match at all', async () => {
    const preview = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: '2024-01-15 no prefix here',
      timePrefix: 'when=',
    });
    expect(preview.sample).toEqual({ status: 'no-match', searchedFrom: 0 });
  });

  it('survives a TIME_PREFIX that is not a valid regex, and says why', async () => {
    // Not a plain 'no-match', which would blame the format for a broken prefix.
    const preview = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: '2024-01-15',
      timePrefix: '(unbalanced',
    });
    // Which reason depends on validateRegex (an unbalanced group also defeats
    // the ReDoS scanner, which then assumes the worst) — the point is that
    // there is one.
    expect(preview.sample?.status).toBe('prefix-refused');
    expect(preview.sample?.status === 'prefix-refused' ? preview.sample.reason : '').not.toBe('');
  });

  it('runs a backtracking-prone TIME_PREFIX rather than refusing it (#368)', async () => {
    // `(a+)+$` is valid PCRE and Splunk runs it, so the preview does too — in
    // the worker, where PCRE's
    // match limit and the watchdog bound it.
    const preview = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: `${'a'.repeat(16)}! 2024-01-15`,
      timePrefix: '(a+)+$',
    });
    expect(preview.sample?.status).toBe('no-match');
  });

  it('translates PCRE in TIME_PREFIX the way the engine does (#297)', async () => {
    // Plain `new RegExp` rejected both of these, so the preview said "no match"
    // for prefixes the pipeline applies without complaint.
    const named = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: 'id=5 ts=2024-01-15 rest',
      timePrefix: '(?P<key>ts)=',
    });
    expect(named.sample).toMatchObject({ status: 'matched', text: '2024-01-15' });

    const insensitive = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: 'id=5 TS=2024-01-15 rest',
      timePrefix: '(?i)ts=',
    });
    expect(insensitive.sample).toMatchObject({ status: 'matched', text: '2024-01-15' });
  });

  it('searches no more than the first 4 KB of the sample line (#297)', async () => {
    const date = '2024-01-15';
    const within = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: `${'x'.repeat(MAX_PREVIEW_SAMPLE_LENGTH - date.length - 3)}ts=${date}`,
      timePrefix: 'ts=',
    });
    expect(within.sample).toMatchObject({ status: 'matched', text: date });

    const beyond = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: `${'x'.repeat(MAX_PREVIEW_SAMPLE_LENGTH)}ts=${date}`,
      timePrefix: 'ts=',
    });
    expect(beyond.sample).toEqual({ status: 'no-match', searchedFrom: 0 });
  });

  it('describes a format synchronously, with no sample, for the completion detail', () => {
    expect(describeTimeFormat('%Y-%m-%d %H:%i', NOW)).toEqual({
      rendered: '2026-08-04 12:%i',
      sample: null,
      unsupported: [{ specifier: '%i', index: 12 }],
    });
  });

  it('still lists the unsupported specifiers when the current time cannot be rendered', () => {
    // formatStrftime refuses an Invalid Date. The specifiers do not depend on it.
    expect(describeTimeFormat('%Y %i', new Date(Number.NaN))).toEqual({
      rendered: null,
      sample: null,
      unsupported: [{ specifier: '%i', index: 3 }],
    });
  });

  it('carries the unsupported specifiers through', async () => {
    const preview = await buildTimeFormatPreview('%Y-%m-%d %H:%i', { now: NOW });
    expect(preview.unsupported).toHaveLength(1);
  });
});

describe('renderTimeFormatPreview', () => {
  it('shows the rendering, the sample result and the caveats together', async () => {
    const markdown = renderTimeFormatPreview(
      await buildTimeFormatPreview('%Y-%m-%d', { now: NOW, sampleLine: '2024-01-15 x' }),
    );
    expect(markdown).toContain('**Now:** `2026-08-04`');
    expect(markdown).toContain('2024-01-15T00:00:00.000Z');
  });

  it('names each unsupported specifier and where it sits', async () => {
    const markdown = renderTimeFormatPreview(await buildTimeFormatPreview('%Y-%m-%d %H:%i', { now: NOW }));
    expect(markdown).toContain('`%i` (offset 12)');
    expect(markdown).toContain('literal text');
  });

  it('says the sample did not match rather than staying silent', async () => {
    const markdown = renderTimeFormatPreview(
      await buildTimeFormatPreview('%Y/%m/%d', { now: NOW, sampleLine: '2024-01-15 x' }),
    );
    expect(markdown).toContain('no match');
  });

  it.each<[string, NonNullable<TimeFormatPreview['sample']>, string]>([
    [
      'a match that is not a date',
      { status: 'unparseable', text: '2024-02-30' },
      '**Sample:** matched `2024-02-30`, but it could not be assembled into a date — check the field order and ranges.',
    ],
    [
      'no match with no prefix',
      { status: 'no-match', searchedFrom: 0 },
      '**Sample:** no match in the first event line.',
    ],
    [
      'no match after a prefix',
      { status: 'no-match', searchedFrom: 3 },
      '**Sample:** no match at offset 3 (immediately after TIME_PREFIX).',
    ],
    [
      'a prefix that does not compile',
      { status: 'prefix-refused', reason: 'missing closing parenthesis (offset 11)' },
      '**Sample:** not tried — TIME_PREFIX was not run: missing closing parenthesis \\(offset 11\\)',
    ],
    [
      'a prefix that ran past the watchdog',
      { status: 'prefix-timed-out', timeoutMs: 1_000 },
      '**Sample:** preview timed out — matching TIME_PREFIX and TIME_FORMAT against the sample line ran for over 1 s and was stopped.',
    ],
    [
      'an error in the worker',
      { status: 'prefix-error', reason: 'No events to probe.' },
      '**Sample:** not tried — matching the sample line failed: No events to probe\\.',
    ],
  ])('says what happened to the sample: %s', (_case, sample, expected) => {
    expect(renderTimeFormatPreview({ rendered: null, sample, unsupported: [] })).toBe(expected);
  });

  it('lists each unsupported specifier in one line, after the rendering', () => {
    expect(renderTimeFormatPreview(describeTimeFormat('%H:%i %c', NOW))).toBe(
      '**Now:** `12:%i %c`\n\n**Not simulated:** `%i` (offset 3), `%c` (offset 6) — the preview treats these as literal text.',
    );
  });

  it('keeps a backtick in the format or the sample inside its code span (#296)', () => {
    // Both the rendered format and the matched sample text are user-authored.
    // A bare pair of backticks let a backtick in either close the span and
    // turn the rest into live Markdown — here, a link.
    const markdown = renderTimeFormatPreview({
      rendered: 'x`[a](https://example.invalid)`',
      sample: { status: 'matched', text: '`[b](https://example.invalid)', iso: '2024-01-15T00:00:00.000Z' },
      unsupported: [],
    });
    const links: string[] = [];
    void marked.walkTokens(marked.lexer(markdown), (t) => {
      if (t.type === 'link') links.push(t.raw);
    });
    expect(links).toEqual([]);
    expect(markdown).toContain('**Now:** `` x`[a](https://example.invalid)` ``');
  });
});
