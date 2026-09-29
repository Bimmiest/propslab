import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import { breakLines } from '../processors/lineBreaker';
import type { ConfDirective, EventMetadata } from '../types';
import { runCtx } from './runCtx';

const META: EventMetadata = { index: 'main', host: '', source: '', sourcetype: 'st' };
const dir = (key: string, value: string): ConfDirective =>
  ({ key, value, line: 1, directiveType: key });

// Keys are compared case-sensitively, as confParser's "is ignored" warning for
// a mis-cased attribute says: the simulator must not honour a directive it has
// just declared dead.
describe('lineBreaker — directive keys are case-sensitive (#119)', () => {
  it('ignores a mis-cased line_breaker, matching the parser warning', () => {
    const { result, diagnostics } = runPipeline(
      'aXbXc',
      META,
      '[st]\nline_breaker = (X)\nSHOULD_LINEMERGE = false\n',
      '',
    );

    expect(diagnostics.some((d) => d.message.includes('"line_breaker" is ignored'))).toBe(true);
    // Splunk ignores the attribute entirely, so the default breaker applies and
    // the whole input stays one event.
    expect(result.events.map((e) => e._raw)).toEqual(['aXbXc']);
  });

  it('honours the correctly-cased LINE_BREAKER', () => {
    const { result } = runPipeline(
      'aXbXc',
      META,
      '[st]\nLINE_BREAKER = (X)\nSHOULD_LINEMERGE = false\n',
      '',
    );
    expect(result.events.map((e) => e._raw)).toEqual(['a', 'b', 'c']);
  });

  it.each(['should_linemerge', 'break_only_before', 'must_break_after', 'max_events'])(
    'ignores mis-cased %s',
    (key) => {
      const events = breakLines('a\nb\nc', [dir(key, 'false')], META, runCtx());
      // With every merge directive mis-cased, defaults apply: SHOULD_LINEMERGE
      // is on and no date-like line breaks, so all three lines merge.
      expect(events).toHaveLength(1);
    },
  );
});
