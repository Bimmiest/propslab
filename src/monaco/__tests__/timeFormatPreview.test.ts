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
import { buildTimeFormatPreview, renderTimeFormatPreview } from '../timeFormatPreview';
import { unsupportedSpecifiers } from '../../utils/strftime';

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
  it('renders the current time with the pattern', () => {
    const preview = buildTimeFormatPreview('%Y-%m-%d', { now: NOW });
    expect(preview.rendered).toBe('2026-08-04');
  });

  it('says nothing at all for an empty value', () => {
    const preview = buildTimeFormatPreview('   ', { now: NOW });
    expect(preview.rendered).toBeNull();
    expect(renderTimeFormatPreview(preview)).toBe('');
  });

  it('matches a sample line and resolves it', () => {
    const preview = buildTimeFormatPreview('%Y-%m-%d %H:%M:%S', {
      now: NOW,
      sampleLine: '2024-01-15 10:00:00 user=alice',
    });
    expect(preview.sample).toEqual({
      status: 'matched',
      text: '2024-01-15 10:00:00',
      iso: '2024-01-15T10:00:00.000Z',
    });
  });

  it('reports a sample that does not match', () => {
    const preview = buildTimeFormatPreview('%Y/%m/%d', {
      now: NOW,
      sampleLine: '2024-01-15 10:00:00 user=alice',
    });
    expect(preview.sample?.status).toBe('no-match');
  });

  it('honours TIME_PREFIX the way the engine does', () => {
    const preview = buildTimeFormatPreview('%Y-%m-%dT%H:%M:%S', {
      now: NOW,
      sampleLine: 'id=5 ts=2024-01-15T10:00:00 rest',
      timePrefix: 'ts=',
    });
    expect(preview.sample).toMatchObject({ status: 'matched', text: '2024-01-15T10:00:00' });
  });

  it('anchors after TIME_PREFIX rather than scanning the whole line (#66)', () => {
    // The date is present but NOT immediately after the prefix, which is what a
    // real indexer refuses — so the preview must refuse it too.
    const preview = buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: 'ts=pending job started 2024-01-15',
      timePrefix: 'ts=',
    });
    expect(preview.sample?.status).toBe('no-match');
  });

  it('reports where it started looking when a prefix moved the search', () => {
    const preview = buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: 'ts=nothing here',
      timePrefix: 'ts=',
    });
    expect(preview.sample).toEqual({ status: 'no-match', searchedFrom: 3 });
  });

  it('reports a TIME_PREFIX that does not match at all', () => {
    const preview = buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: '2024-01-15 no prefix here',
      timePrefix: 'when=',
    });
    expect(preview.sample).toEqual({ status: 'no-match', searchedFrom: 0 });
  });

  it('survives a TIME_PREFIX that is not a valid regex', () => {
    const preview = buildTimeFormatPreview('%Y-%m-%d', {
      now: NOW,
      sampleLine: '2024-01-15',
      timePrefix: '(unbalanced',
    });
    expect(preview.sample?.status).toBe('no-match');
  });

  it('carries the unsupported specifiers through', () => {
    const preview = buildTimeFormatPreview('%Y-%m-%d %H:%i', { now: NOW });
    expect(preview.unsupported).toHaveLength(1);
  });
});

describe('renderTimeFormatPreview', () => {
  it('shows the rendering, the sample result and the caveats together', () => {
    const markdown = renderTimeFormatPreview(
      buildTimeFormatPreview('%Y-%m-%d', { now: NOW, sampleLine: '2024-01-15 x' }),
    );
    expect(markdown).toContain('**Now:** `2026-08-04`');
    expect(markdown).toContain('2024-01-15T00:00:00.000Z');
  });

  it('names each unsupported specifier and where it sits', () => {
    const markdown = renderTimeFormatPreview(buildTimeFormatPreview('%Y-%m-%d %H:%i', { now: NOW }));
    expect(markdown).toContain('`%i` (offset 12)');
    expect(markdown).toContain('literal text');
  });

  it('says the sample did not match rather than staying silent', () => {
    const markdown = renderTimeFormatPreview(
      buildTimeFormatPreview('%Y/%m/%d', { now: NOW, sampleLine: '2024-01-15 x' }),
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
