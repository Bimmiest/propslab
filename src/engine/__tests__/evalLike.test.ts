// ---------------------------------------------------------------------------
// evalLike.test.ts
// like() built `.*.*` from `%%`, the ReDoS guard refused it, and like() then
// answered false for every event without a word (#303).
//
// Doc-derived: like(TEXT, PATTERN) is true when TEXT matches PATTERN, with `%`
// for any run of characters and `_` for exactly one. No fidelity fixture covers
// eval, so the assertions are narrow.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as splunkRegex from '../../utils/splunkRegex';
import { applyEvalExpressions } from '../processors/evalProcessor';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';

// Replaced per test by `refuse` below; otherwise the real guard.
vi.mock('../../utils/splunkRegex', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../utils/splunkRegex')>();
  return { ...real, safeRegex: vi.fn(real.safeRegex) };
});

function event(fields: Record<string, string>): SplunkEvent {
  return {
    _raw: 'raw',
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

const evalDir = (className: string, value: string): ConfDirective =>
  ({ key: `EVAL-${className}`, value, line: 3, directiveType: 'EVAL', className });

function like(s: string, pattern: string) {
  const diagnostics: ValidationDiagnostic[] = [];
  const out = applyEvalExpressions(
    [event({ s })],
    [evalDir('r', `if(like(s, "${pattern}"), "y", "n")`)],
    diagnostics,
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
    const out = applyEvalExpressions(events, [evalDir('r', 'like(s, "a%")')], diagnostics);

    expect(out[0]!.fields['r']).toBe('false');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warning', directiveKey: 'EVAL-r', line: 3 });
    expect(diagnostics[0]?.message).toContain('like() pattern "^a.*$"');
    expect(diagnostics[0]?.message).toContain('evaluated to false');
  });
});
