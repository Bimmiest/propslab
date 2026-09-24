// ---------------------------------------------------------------------------
// timeFormatPreview.test.ts
// The TIME_FORMAT live preview (#90).
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
import type { PrefixMatcher } from '../timePrefixMatcher';
import { probeTimestamps } from '../../engine/timestampMatch';
import { unsupportedSpecifiers } from '../../utils/strftime';

/**
 * Stands in for the worker (#334) by running what the worker runs — the
 * Timestamp prober with no TIME_FORMAT — so these tests still pin the preview
 * to the engine's reading of TIME_PREFIX. The worker plumbing itself is
 * covered in timePrefixMatcher.test.ts.
 */
const proberInline: PrefixMatcher = (pattern, sample) => {
  const [probe] = probeTimestamps([sample], { timePrefix: pattern, timeFormat: null, maxLookahead: 0, tz: null });
  return Promise.resolve(probe?.prefix ? { status: 'matched', end: probe.prefix.end } : { status: 'no-match' });
};

async function buildTimeFormatPreview(format: string, options: TimeFormatPreviewOptions = {}): Promise<TimeFormatPreview> {
  const preview = await buildWith(format, { matchPrefix: proberInline, ...options });
  if (preview === null) throw new Error('unexpectedly cancelled');
  return preview;
}

const NOW = new Date('2026-08-04T12:30:45.000Z');

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
    // Previously reported as a plain 'no-match', which blamed the format for
    // what was a broken prefix (#297).
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

  it('refuses a ReDoS-prone TIME_PREFIX instead of running it on the main thread (#297)', async () => {
    // `(a+)+$` against a long run of `a`s ending in a mismatch is the textbook
    // catastrophic case: run for real, this hangs the tab.
    const started = Date.now();
    const preview = await buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: `${'a'.repeat(40)}! 2024-01-15`,
      timePrefix: '(a+)+$',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(preview.sample?.status).toBe('prefix-refused');
    expect(preview.sample?.status === 'prefix-refused' ? preview.sample.reason : '').toMatch(/catastrophic backtracking/);
    expect(renderTimeFormatPreview(preview)).toMatch(/TIME_PREFIX was not run: .*catastrophic backtracking/);
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
