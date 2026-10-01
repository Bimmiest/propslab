// ---------------------------------------------------------------------------
// evalLike.test.ts
// like()'s wildcard translation: a run of `%` is one `.*`, so `%%` matches
// like `%` does; and `%` and `_` match newlines, with no match before a final
// newline (#447).
//
// Doc-derived: like(TEXT, PATTERN) is true when TEXT matches PATTERN, with `%`
// for any run of characters and `_` for exactly one. The assertions are narrow.
// The newline behaviour cites #447, where the documentation is silent.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as splunkRegex from '../../utils/splunkRegex';
import { applyEvalExpressions } from '../processors/evalProcessor';
import { evaluateExpression } from '../processors/eval/evaluator';
import { runPipeline } from '../pipeline';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

// Replaced per test by `refuse` below; otherwise the real guard.
vi.mock('../../utils/splunkRegex', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../utils/splunkRegex')>();
  return { ...real, safeRegex: vi.fn(real.safeRegex) };
});

function event(fields: Record<string, string>): SplunkEvent {
  return makeEvent('raw', { fields });
}

const evalDir = (className: string, value: string): ConfDirective => ({
  key: `EVAL-${className}`,
  value,
  line: 3,
  directiveType: 'EVAL',
  className,
});

function like(s: string, pattern: string) {
  const diagnostics: ValidationDiagnostic[] = [];
  const out = applyEvalExpressions(
    [event({ s })],
    [evalDir('r', `if(like(s, "${pattern}"), "y", "n")`)],
    runCtx(FIXED_NOW, diagnostics),
  );
  return { result: out[0]!.fields['r'], diagnostics };
}

afterEach(() => {
  vi.mocked(splunkRegex.safeRegex).mockReset();
});

describe('like() with consecutive % (#303)', () => {
  it.each([
    ['%%', 'anything', 'y'],
    ['%%', '', 'y'],
    ['a%%b', 'a-middle-b', 'y'],
    ['a%%b', 'ab', 'y'],
    ['a%%b', 'a-middle-c', 'n'],
    ['%%_%%', 'x', 'y'],
    ['%%_%%', '', 'n'],
  ])('like(s, "%s") on "%s" is %s, the same as a single %%', (pattern, s, expected) => {
    const { result, diagnostics } = like(s, pattern);
    expect(result).toBe(expected);
    expect(diagnostics).toEqual([]);
  });

  it('still treats % and _ literally where escaped regex metacharacters sit beside them', () => {
    expect(like('a.b', '%.%').result).toBe('y');
    expect(like('ab', '%.%').result).toBe('n');
  });
});

describe('like() reports a pattern the guard refuses (#303)', () => {
  it('warns once, as replace()/match()/mvfind() do, and evaluates to false', () => {
    // Nothing like() builds after the collapse is refused by today's guard, so
    // the refusal is forced: this pins that a future, stricter guard cannot
    // bring the silent failure back.
    vi.mocked(splunkRegex.safeRegex).mockReturnValue(null);
    const diagnostics: ValidationDiagnostic[] = [];
    const events = Array.from({ length: 5 }, () => event({ s: 'abc' }));
    const out = applyEvalExpressions(
      events,
      [evalDir('r', 'if(like(s, "a%"), "true", "false")')],
      runCtx(FIXED_NOW, diagnostics),
    );

    expect(out[0]!.fields['r']).toBe('false');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warning', directiveKey: 'EVAL-r', line: 3 });
    // `(?s)^…\z` since #447; the regex like() built was `^a.*$` before.
    expect(diagnostics[0]?.message).toContain('like() pattern "(?s)^a.*\\z"');
    expect(diagnostics[0]?.message).toContain('evaluated to false');
  });

  it('reports the LIKE operator the same way, since it is the same function', () => {
    vi.mocked(splunkRegex.safeRegex).mockReturnValue(null);
    const diagnostics: ValidationDiagnostic[] = [];
    const out = applyEvalExpressions(
      [event({ s: 'abc' })],
      [evalDir('r', 'if(s LIKE "a%", "true", "false")')],
      runCtx(FIXED_NOW, diagnostics),
    );
    expect(out[0]!.fields['r']).toBe('false');
    expect(diagnostics.map((d) => d.message)).toEqual([
      'EVAL-r: like() pattern "(?s)^a.*\\z" could not be compiled (invalid regex), so it evaluated to false.',
    ]);
  });
});

describe('like() and LIKE on text with newlines (#447)', () => {
  const value = (expr: string, s: string) => evaluateExpression(expr, event({ s }), undefined, FIXED_NOW);

  it.each([
    ['first\nERROR here\nlast', '%ERROR%', true],
    ['a\nb', 'a_b', true],
    ['a\r\nb', 'a__b', true],
    ['a\nb', 'a%', true],
    ['abc\n', 'abc', false],
    ['abc\n', 'abc%', true],
    ['abc\n', 'abc_', true],
    ['abc\n\n', 'abc_', false],
    ['\nabc', 'abc', false],
    ['first\nlast', 'last', false],
  ] as const)('like(%j, %j) is %s, and so is LIKE', (s, pattern, expected) => {
    expect(value(`like(s, "${pattern}")`, s)).toBe(expected);
    expect(value(`s LIKE "${pattern}"`, s)).toBe(expected);
  });

  it('leaves match() as it was: its `.` does not match a newline', () => {
    expect(value('match(s, "^a.b$")', 'a\nb')).toBe(false);
    expect(value('match(s, "^a.b$")', 'a-b')).toBe(true);
  });

  it('finds ERROR in a multi-line event through the pipeline', () => {
    const raw = 'START first\nERROR here\nlast\nSTART second\nfine';
    const props =
      '[st]\nSHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE = ^START\nBREAK_ONLY_BEFORE_DATE = false\n' +
      'EVAL-fn = if(like(_raw, "%ERROR%"), "y", "n")\n' +
      'EVAL-op = if(_raw LIKE "%ERROR%", "y", "n")\n' +
      'EVAL-re = if(match(_raw, "^START.*last$"), "y", "n")\n';
    const { result } = runPipeline(raw, { index: 'main', host: 'h', source: 's', sourcetype: 'st' }, props, '', {
      perEventPipeline: false,
      captureOffsets: false,
      now: FIXED_NOW,
    });
    expect(result.events.map((e) => e._raw)).toEqual(['START first\nERROR here\nlast', 'START second\nfine']);
    expect(result.events.map((e) => [e.fields['fn'], e.fields['op'], e.fields['re']])).toEqual([
      ['y', 'y', 'n'],
      ['n', 'n', 'n'],
    ]);
  });
});
