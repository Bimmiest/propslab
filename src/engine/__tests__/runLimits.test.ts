// ---------------------------------------------------------------------------
// runLimits.test.ts
// The bounds on one run's work (`RunLimits`, runContext.ts), through
// `runPipeline`, which takes them as `PipelineOptions.limits` (#478, #479):
//
//   - maxRawChars: input past it is cut back to the last complete line;
//   - maxEvents: line breaking stops there and says so;
//   - explanationsPerDirective: missed events a directive's no-match is
//     analysed for;
//   - maxRunMs: the stages stop at the stage that spends it (#560), and
//     MATCH_LIMIT and DEPTH_LIMIT are capped so that one match cannot outlast it.
//
// Examples pin the edges; a fast-check property per limit shows the bound
// holds for arbitrary input. These are the simulator's own budgets, not
// Splunk behaviour, so nothing here is doc-derived.
//
// The seed comes from FC_SEED when set, and is fixed otherwise.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { runPipeline } from '../pipeline';
import { splitSegments } from '../processors/lineBreaker';
import { DEFAULT_LIMITS, type RunLimits } from '../runContext';
import type { EventMetadata, PipelineOptions, ValidationDiagnostic } from '../types';
import type { RunStage } from '../runStages';
import { fcSeed } from '../../test/fcSeed';

const META: EventMetadata = { index: 'main', host: 'h', source: '/log', sourcetype: 'st' };
const NOW = Date.UTC(2026, 8, 1);
const UNMERGED = '[st]\nSHOULD_LINEMERGE = false\n';

const run = (raw: string, props: string, limits: Partial<RunLimits>, options: Partial<PipelineOptions> = {}) =>
  runPipeline(raw, META, props, '', { perEventPipeline: false, now: NOW, limits, ...options });

const truncationWarnings = (diags: ValidationDiagnostic[]) =>
  diags.filter((d) => d.message.startsWith('Input truncated'));
const capWarnings = (diags: ValidationDiagnostic[]) =>
  diags.filter((d) => d.message.startsWith('Line breaking stopped'));

describe('RunLimits defaults (#479)', () => {
  it('caps events in the low tens of thousands, above the 20,000-event perf budget', () => {
    expect(DEFAULT_LIMITS.maxEvents).toBe(25_000);
    expect(DEFAULT_LIMITS.maxRawChars).toBe(1_000_000);
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });

  it('applies the default cap when the caller passes none', () => {
    const { result, diagnostics } = runPipeline('a\n'.repeat(25_001), META, UNMERGED, '', {
      perEventPipeline: false,
      now: NOW,
    });
    expect(result.eventCount).toBe(25_000);
    expect(capWarnings(diagnostics)).toHaveLength(1);
  });
});

describe('maxRunMs (#560)', () => {
  const stops = (diags: ValidationDiagnostic[]) => diags.filter((d) => d.message.startsWith('The run stopped'));

  /**
   * Run with a 1 s budget on a clock that jumps 2 s when `stage` starts, so
   * the stop is decided by the stage, not by how fast the machine is.
   */
  function runOutOfTimeAt(
    stage: RunStage,
    raw: string,
    props: string,
    transforms = '',
    options: Partial<PipelineOptions> = {},
  ) {
    let clock = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      return runPipeline(raw, META, props, transforms, {
        perEventPipeline: false,
        now: NOW,
        limits: { maxRunMs: 1_000 },
        onStage: (s) => {
          if (s === stage) clock = 2_000;
        },
        ...options,
      });
    } finally {
      spy.mockRestore();
    }
  }

  it('stops in the stage that spends it, keeps the stages before, and runs none after', () => {
    const { result, diagnostics } = runOutOfTimeAt(
      'EXTRACT',
      'one\ntwo',
      `${UNMERGED}EXTRACT-word = (?<word>\\w+)\nEVAL-late = "x"\n`,
    );
    expect(result.events.map((e) => e._raw)).toEqual(['one', 'two']);
    expect(result.events.map((e) => e.fields['word'] ?? e.fields['late'])).toEqual([undefined, undefined]);
    expect(stops(diagnostics)).toHaveLength(1);
    expect(stops(diagnostics)[0]?.level).toBe('error');
    expect(stops(diagnostics)[0]?.message).toContain('"EXTRACT"');
  });

  it('runs no stage once it is spent, and says so once', () => {
    let clock = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock++);
    try {
      const { result, diagnostics } = run('one\ntwo', UNMERGED, { maxRunMs: 0 });
      expect(result.eventCount).toBe(0);
      expect(stops(diagnostics)).toHaveLength(1);
      expect(stops(diagnostics)[0]?.message).toContain('"LINE_BREAKER"');
    } finally {
      spy.mockRestore();
    }
  });

  // Each of these stages catches what its expressions throw, and must let the stop through.
  it.each<[RunStage, string, string]>([
    ['EVAL', `${UNMERGED}EVAL-b = if(match(_raw, "o"), "y", "n")\n`, ''],
    ['TRANSFORMS', `${UNMERGED}TRANSFORMS-ie = ie\n`, '[ie]\nINGEST_EVAL = b=if(match(_raw, "o"), "y", "n")\n'],
    ['TRANSFORMS', `${UNMERGED}RULESET-r = stop\n`, '[stop]\nSTOP_PROCESSING_IF = match(_raw, "o")\n'],
    ['SEDCMD attribution', `${UNMERGED}SEDCMD-mask = s/one/xxx/\nEXTRACT-word = (?<word>\\w+)\n`, ''],
  ])("stops at %s, through the stage's own error handling", (stage, props, transforms) => {
    const { diagnostics } = runOutOfTimeAt(stage, 'one', props, transforms);
    expect(stops(diagnostics).map((d) => d.message)).toEqual([expect.stringContaining(`"${stage}"`)]);
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(1);
  });

  it('says so once in a per-event run, not once per event', () => {
    const { diagnostics } = runOutOfTimeAt(
      'search time per event',
      'one\ntwo\nthree',
      `${UNMERGED}EXTRACT-word = (?<word>\\w+)\n`,
      '',
      { perEventPipeline: true },
    );
    expect(stops(diagnostics).map((d) => d.message)).toEqual([expect.stringContaining('"EXTRACT"')]);
  });

  it('does not bound a run by default', () => {
    expect(DEFAULT_LIMITS.maxRunMs).toBe(Infinity);
    const { result, diagnostics } = runOutOfTimeAt('EXTRACT', 'one', `${UNMERGED}EXTRACT-word = (?<word>\\w+)\n`, '', {
      limits: {},
    });
    expect(result.events[0]?.fields['word']).toBe('one');
    expect(stops(diagnostics)).toEqual([]);
  });

  it('reports a MATCH_LIMIT or DEPTH_LIMIT above the cap, which no run budget can interrupt', () => {
    const capNotes = (props: string) =>
      run('one', props, {}).diagnostics.filter((d) => d.message.includes('The preview stops a match at'));
    const notes = capNotes(`${UNMERGED}MATCH_LIMIT = 0\nDEPTH_LIMIT = 20000000\n`);
    expect(notes.map((d) => [d.level, d.directiveKey])).toEqual([
      ['info', 'MATCH_LIMIT'],
      ['info', 'DEPTH_LIMIT'],
    ]);
    expect(notes[0]?.message).toMatch(/^MATCH_LIMIT = 0 means no limit/);
    expect(notes[1]?.message).toContain('is above 10,000,000');
    expect(capNotes(`${UNMERGED}MATCH_LIMIT = 10000000\nDEPTH_LIMIT = 500\n`)).toEqual([]);
  });
});

describe('maxRawChars (#478)', () => {
  it('keeps input at or under the cap untouched, with no warning', () => {
    const { result, diagnostics } = run('ab\ncd', UNMERGED, { maxRawChars: 5 });
    expect(result.originalRaw).toBe('ab\ncd');
    expect(truncationWarnings(diagnostics)).toEqual([]);
  });

  it('keeps a line whose newline sits exactly at the cap', () => {
    // 'ab\ncd' is five characters and the sixth is its newline: the line is
    // complete, so nothing of it is dropped.
    const { result, diagnostics } = run('ab\ncd\nef', UNMERGED, { maxRawChars: 5 });
    expect(result.originalRaw).toBe('ab\ncd');
    expect(result.events.map((e) => e._raw)).toEqual(['ab', 'cd']);
    expect(truncationWarnings(diagnostics)).toEqual([
      {
        level: 'warning',
        file: 'props.conf',
        message:
          'Input truncated to 5 characters for performance (original: 8). Truncation is aligned to the last ' +
          'complete line, so the final partial event is dropped rather than processed half-formed.',
      },
    ]);
  });

  it('drops a line the cap cuts through', () => {
    const { result } = run('ab\ncde\nf', UNMERGED, { maxRawChars: 5 });
    expect(result.originalRaw).toBe('ab');
    expect(result.events.map((e) => e._raw)).toEqual(['ab']);
  });

  it('does not cut back to a line break at the very start, which would leave nothing', () => {
    const { result } = run('\nabcdefgh', UNMERGED, { maxRawChars: 5 });
    expect(result.originalRaw).toBe('\nabcd');
  });

  it('keeps the cut text when there is no line break to align to', () => {
    const { result, diagnostics } = run('abcdefgh', UNMERGED, { maxRawChars: 5 });
    expect(result.originalRaw).toBe('abcde');
    expect(truncationWarnings(diagnostics)).toHaveLength(1);
  });
});

describe('maxEvents (#479)', () => {
  it('stops LINE_BREAKER = () over a large input at the cap, and says where', () => {
    // Every character becomes an event: 200,000 characters would be 200,000
    // events without the cap.
    const raw = 'x'.repeat(200_000);
    const props = '[st]\nSHOULD_LINEMERGE = false\nLINE_BREAKER = ()\n';
    const { result, diagnostics } = run(raw, props, { maxEvents: 1000 });
    expect(result.eventCount).toBe(1000);
    expect(result.events.every((e) => e._raw === 'x')).toBe(true);
    expect(capWarnings(diagnostics)).toEqual([
      {
        level: 'warning',
        file: 'raw',
        line: 1,
        message:
          'Line breaking stopped at 1,000 events, the most one run produces. The input from line 1 on was not ' +
          'processed. Check LINE_BREAKER if the input should break into fewer events.',
      },
    ]);
  });

  it('holds LINE_BREAKER = () to the default cap over a large input', () => {
    const props = '[st]\nSHOULD_LINEMERGE = false\nLINE_BREAKER = ()\n';
    const { result, diagnostics } = runPipeline('y'.repeat(100_000), META, props, '', {
      perEventPipeline: false,
      now: NOW,
    });
    expect(result.eventCount).toBe(DEFAULT_LIMITS.maxEvents);
    expect(capWarnings(diagnostics)).toHaveLength(1);
  });

  it('produces exactly the cap without a warning when the input breaks into that many', () => {
    const { result, diagnostics } = run('a\nb\nc', UNMERGED, { maxEvents: 3 });
    expect(result.events.map((e) => e._raw)).toEqual(['a', 'b', 'c']);
    expect(capWarnings(diagnostics)).toEqual([]);
  });

  it('names the first line it dropped', () => {
    const { result, diagnostics } = run('a\nb\nc\nd', UNMERGED, { maxEvents: 2 });
    expect(result.events.map((e) => e._raw)).toEqual(['a', 'b']);
    expect(capWarnings(diagnostics).map((d) => d.line)).toEqual([3]);
  });

  it('caps merged events, not the lines merged into them', () => {
    // Line merging on: three dated events of two lines each. The cap counts
    // events, so two events keep all four of their lines.
    const raw = [
      '2026-08-01 10:00:00 one',
      '  more',
      '2026-08-01 10:00:01 two',
      '  more',
      '2026-08-01 10:00:02 three',
      '  more',
    ].join('\n');
    const { result, diagnostics } = run(raw, '[st]\n', { maxEvents: 2 });
    expect(result.events.map((e) => e._raw)).toEqual([
      '2026-08-01 10:00:00 one\n  more',
      '2026-08-01 10:00:01 two\n  more',
    ]);
    expect(capWarnings(diagnostics).map((d) => d.line)).toEqual([5]);
  });
});

describe('splitSegments maxSegments (#479)', () => {
  it('stops at the requested count and leaves the rest of the input unsplit', () => {
    const texts = (max?: number) => splitSegments('a\nb\nc', '(\\n)', [], undefined, max).map((s) => s.text);
    expect(texts(2)).toEqual(['a', 'b']);
    expect(texts(1)).toEqual(['a']);
    expect(texts(3)).toEqual(['a', 'b', 'c']);
    expect(texts()).toEqual(['a', 'b', 'c']);
  });
});

describe('explanationsPerDirective', () => {
  it("analyses each directive's misses up to the limit, then records them unexplained", () => {
    const props = `${UNMERGED}EXTRACT-miss = (?<never>zzz)\n`;
    const { result } = run('a\nb\nc\nd', props, { explanationsPerDirective: 1 });
    expect(result.events.map((e) => e.noOps?.find((n) => n.directive === 'EXTRACT-miss')?.reason.kind)).toEqual([
      'no-match',
      'not-explained',
      'not-explained',
      'not-explained',
    ]);
  });
});

describe('every RunLimits entry bounds the run (#479)', () => {
  fc.configureGlobal({ seed: fcSeed(479), numRuns: 100 });

  const line = fc.string({ unit: fc.constantFrom('a', 'b', ' ', '=', '1'), maxLength: 6 });
  const lines = fc.array(line, { maxLength: 30 }).map((ls) => ls.join('\n'));

  it('maxRawChars: what is processed is a prefix of the input no longer than the cap, ending on a line', () => {
    fc.assert(
      fc.property(lines, fc.integer({ min: 1, max: 60 }), (raw, maxRawChars) => {
        fc.pre(raw.trim() !== '');
        const { result } = run(raw, UNMERGED, { maxRawChars });
        const kept = result.originalRaw;
        expect(kept.length).toBeLessThanOrEqual(maxRawChars);
        expect(raw.startsWith(kept)).toBe(true);
        if (raw.length <= maxRawChars) {
          expect(kept).toBe(raw);
        } else if (raw.slice(1, maxRawChars + 1).includes('\n')) {
          // A line break inside (or just past) the cap: whole lines only, and
          // no complete line left behind.
          expect(raw[kept.length]).toBe('\n');
          expect(raw.slice(kept.length + 1, maxRawChars + 1).includes('\n')).toBe(false);
        }
      }),
    );
  });

  it('maxEvents: never more events than the cap, and the same first events as an uncapped run', () => {
    const breaker = fc.constantFrom(undefined, '()', '(\\n)', '(a)', '([\\r\\n]+)');
    fc.assert(
      fc.property(lines, breaker, fc.boolean(), fc.integer({ min: 1, max: 20 }), (raw, lb, merge, maxEvents) => {
        fc.pre(raw.trim() !== '');
        const props = `[st]\nSHOULD_LINEMERGE = ${String(merge)}\n${lb === undefined ? '' : `LINE_BREAKER = ${lb}\n`}`;
        const capped = run(raw, props, { maxEvents });
        const uncapped = run(raw, props, { maxEvents: Number.MAX_SAFE_INTEGER });
        expect(capped.result.eventCount).toBeLessThanOrEqual(maxEvents);
        expect(capped.result.events.map((e) => e._raw)).toEqual(
          uncapped.result.events.slice(0, maxEvents).map((e) => e._raw),
        );
        expect(capWarnings(capped.diagnostics)).toHaveLength(uncapped.result.eventCount > maxEvents ? 1 : 0);
      }),
    );
  });

  it('explanationsPerDirective: no directive is analysed for more misses than the limit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 0, max: 10 }), (n, limit) => {
        const props = `${UNMERGED}EXTRACT-miss = (?<never>zzz)\nEXTRACT-also = (?<nope>qqq)\n`;
        const raw = Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
        const { result } = run(raw, props, { explanationsPerDirective: limit });
        for (const directive of ['EXTRACT-miss', 'EXTRACT-also']) {
          const kinds = result.events.map((e) => e.noOps?.find((o) => o.directive === directive)?.reason.kind);
          expect(kinds.filter((k) => k === 'no-match')).toHaveLength(Math.min(n, limit));
          expect(kinds.filter((k) => k === 'not-explained')).toHaveLength(Math.max(0, n - limit));
        }
      }),
    );
  });
});
