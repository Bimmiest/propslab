// Tests written against mutants that survived `npm run test:mutation` (#370).
// Each pins a line-breaking behaviour the suite ran but never asserted: how a
// multi-line segment counts against MAX_EVENTS, the MUST_NOT_BREAK_AFTER span
// once it starts mid-input, the line numbers of each event, and the summary
// step the merge leaves in the trace.
import { describe, it, expect } from 'vitest';
import { breakLines } from '../processors/lineBreaker';
import type { ConfDirective, EventMetadata } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function dir(key: string, value: string): ConfDirective {
  return { key, value, line: 3, directiveType: key };
}

const raws = (raw: string, directives: ConfDirective[]) => breakLines(raw, directives, META, runCtx(FIXED_NOW)).map((e) => e._raw);

describe('input with nothing in it', () => {
  it('yields no events for an empty string', () => {
    expect(breakLines('', [], META, runCtx(FIXED_NOW))).toEqual([]);
  });

  it('yields no events for input that is only line breaks', () => {
    expect(breakLines('\n\r\n\n', [], META, runCtx(FIXED_NOW))).toEqual([]);
  });
});

describe('line numbers', () => {
  it('gives each unmerged event its own line', () => {
    const events = breakLines('a\nb\nc', [dir('SHOULD_LINEMERGE', 'false')], META, runCtx(FIXED_NOW));
    expect(events.map((e) => e.lineNumbers)).toEqual([
      { start: 1, end: 1 }, { start: 2, end: 2 }, { start: 3, end: 3 },
    ]);
  });

  it('spans the lines a merged event covers', () => {
    const events = breakLines('2024-01-01 10:00:00 a\nx\ny\n2024-01-02 10:00:00 b', [], META, runCtx(FIXED_NOW));
    expect(events.map((e) => e.lineNumbers)).toEqual([{ start: 1, end: 3 }, { start: 4, end: 4 }]);
  });
});

describe('MAX_EVENTS counts lines, not segments', () => {
  it('counts every line of a multi-line segment', () => {
    // MAX_EVENTS = 2 allows three lines. Each `;`-separated segment is two.
    const out = raws('a\nb;c\nd;e', [dir('LINE_BREAKER', '(;)'), dir('MAX_EVENTS', '2')]);
    expect(out).toEqual(['a\nb', 'c\nd\ne']);
  });

  it.each(['0', '-3'])('falls back to 256 for MAX_EVENTS = %s', (value) => {
    const raw = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    expect(raws(raw, [dir('MAX_EVENTS', value)])).toHaveLength(1);
  });

  it('allows exactly MAX_EVENTS continuation lines', () => {
    expect(raws('a\nb\nc', [dir('MAX_EVENTS', '2')])).toEqual(['a\nb\nc']);
    expect(raws('a\nb\nc\nd', [dir('MAX_EVENTS', '2')])).toEqual(['a\nb\nc', 'd']);
  });
});

describe('MUST_BREAK_AFTER', () => {
  it('breaks after the very first line when it matches', () => {
    expect(raws('END\nx\ny', [dir('MUST_BREAK_AFTER', 'END')])).toEqual(['END', 'x\ny']);
  });
});

describe('MUST_NOT_BREAK_AFTER', () => {
  const dated = (s: string) => `2024-01-01 10:00:00 ${s}`;

  it('suppresses date breaks from the line after a match to the end of the input', () => {
    const raw = [dated('a'), dated('b'), 'HOLD', dated('c'), dated('d')].join('\n');
    expect(raws(raw, [dir('MUST_NOT_BREAK_AFTER', 'HOLD')])).toEqual([dated('a'), [dated('b'), 'HOLD', dated('c'), dated('d')].join('\n')]);
  });

  it('ends the suppression at a MUST_BREAK_AFTER match, which still forces its break', () => {
    const raw = [dated('a'), 'HOLD', dated('b'), 'STOP', dated('c'), dated('d')].join('\n');
    expect(raws(raw, [dir('MUST_NOT_BREAK_AFTER', 'HOLD'), dir('MUST_BREAK_AFTER', 'STOP')])).toEqual([
      [dated('a'), 'HOLD', dated('b'), 'STOP'].join('\n'),
      dated('c'),
      dated('d'),
    ]);
  });

  it('does not defeat MAX_EVENTS', () => {
    const raw = ['HOLD', 'a', 'b', 'c'].join('\n');
    expect(raws(raw, [dir('MUST_NOT_BREAK_AFTER', 'HOLD'), dir('MAX_EVENTS', '1')])).toEqual(['HOLD\na', 'b\nc']);
  });
});

describe('INDEXED_EXTRACTIONS and the merge default', () => {
  it.each(['none', ''])('keeps merging on for INDEXED_EXTRACTIONS = %j', (value) => {
    expect(raws('a\nb', [dir('INDEXED_EXTRACTIONS', value)])).toEqual(['a\nb']);
  });

  it('turns merging off for a line-per-record format', () => {
    expect(raws('a\nb', [dir('INDEXED_EXTRACTIONS', ' JSON ')])).toEqual(['a', 'b']);
  });
});

describe('the trace', () => {
  it('opens each event with its segment, snapshotting at most 200 characters', () => {
    const long = 'x'.repeat(250);
    const [e] = breakLines(long, [], META, runCtx(FIXED_NOW));
    expect(e!.processingTrace[0]).toEqual({
      processor: 'lineBreaker',
      phase: 'index-time',
      description: 'LINE_BREAKER split raw data into segment (lines 1-1)',
      outputSnapshot: 'x'.repeat(200),
      fieldsAdded: [],
      fieldsModified: [],
    });
  });

  it('adds a merge summary naming every rule in force', () => {
    const raw = ['START a', 'b', 'c', 'START d'].join('\n');
    const events = breakLines(
      raw,
      [dir('BREAK_ONLY_BEFORE', 'START'), dir('BREAK_ONLY_BEFORE_DATE', 'false'), dir('MUST_NOT_BREAK_AFTER', 'NEVER'), dir('MUST_BREAK_AFTER', 'NEVER'), dir('MAX_EVENTS', '1')],
      META,
      runCtx(FIXED_NOW),
    );
    expect(events.map((e) => e._raw)).toEqual(['START a\nb', 'c', 'START d']);
    for (const e of events) {
      expect(e.processingTrace[1]).toEqual({
        processor: 'lineBreaker',
        phase: 'index-time',
        description:
          'SHOULD_LINEMERGE=true merged 4 segments into 3 events (BREAK_ONLY_BEFORE=START, BREAK_ONLY_BEFORE_DATE=false, ' +
          'MUST_BREAK_AFTER=NEVER, MUST_NOT_BREAK_AFTER=NEVER, MAX_EVENTS=1 (line cap forced a break))',
        fieldsAdded: [],
        fieldsModified: [],
      });
    }
  });

  it('names MAX_EVENTS\' default when the default cap forced the break', () => {
    const raw = Array.from({ length: 258 }, (_, i) => `l${i}`).join('\n');
    const events = breakLines(raw, [], META, runCtx(FIXED_NOW));
    expect(events).toHaveLength(2);
    expect(events[0]!.processingTrace[1]!.description).toBe(
      'SHOULD_LINEMERGE=true merged 258 segments into 2 events (MAX_EVENTS=256 (line cap forced a break))',
    );
  });

  it('adds a bare summary when no rule is set explicitly', () => {
    const events = breakLines('a\nb', [], META, runCtx(FIXED_NOW));
    expect(events[0]!.processingTrace[1]!.description).toBe('SHOULD_LINEMERGE=true merged 2 segments into 1 events');
  });

  it('adds no summary when nothing merged', () => {
    const date = '2024-01-01 10:00:00';
    for (const events of [
      breakLines(`${date} a\n${date} b`, [], META, runCtx(FIXED_NOW)),
      breakLines('a\nb', [dir('SHOULD_LINEMERGE', 'false')], META, runCtx(FIXED_NOW)),
    ]) {
      for (const e of events) expect(e.processingTrace).toHaveLength(1);
    }
  });
});
