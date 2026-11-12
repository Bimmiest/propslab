import { describe, it, expect } from 'vitest';
import { applySedCommands, parseSedExpression, sedPattern } from '../processors/sedCmd';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

function event(raw: string): SplunkEvent {
  return makeEvent(raw);
}

function sedDir(className: string, value: string): ConfDirective {
  return { key: `SEDCMD-${className}`, value, line: 1, directiveType: 'SEDCMD', className };
}

describe('applySedCommands', () => {
  it('performs a basic substitution', () => {
    const e = applySedCommands([event('hello world')], [sedDir('x', 's/world/there/')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('hello there');
  });

  it('honours the global flag', () => {
    const e = applySedCommands([event('a a a')], [sedDir('x', 's/a/b/g')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('b b b');
  });

  it('uses sed backreferences (\\1) in the replacement', () => {
    const e = applySedCommands([event('id=42')], [sedDir('x', 's/id=(\\d+)/user-\\1/')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('user-42');
  });

  // A literal `$` in the replacement is a substitution pattern in JS, so it is
  // escaped (e.g. $5 must not become part of capture-ref handling).
  it('treats a literal $ in the replacement as literal', () => {
    const e = applySedCommands([event('price')], [sedDir('x', 's/price/$5.00/')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('$5.00');
  });

  // An escaped delimiter in the replacement drops the backslash (GNU sed:
  // `echo abc | sed 's/b/x\/y/'` → `ax/yc`), rather than leaving a stray `\`.
  it('unescapes an escaped delimiter in the replacement', () => {
    const e = applySedCommands([event('abc')], [sedDir('x', 's/b/x\\/y/')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('ax/yc');
  });

  it('unescapes a doubled backslash to a single backslash', () => {
    const e = applySedCommands([event('a')], [sedDir('x', 's/a/x\\\\y/')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('x\\y');
  });

  // A backslash-escaped backslash before a digit is a literal backslash, not a
  // backreference: `\\1` → literal `\1`, never capture group 1.
  it('does not treat an escaped backslash before a digit as a backreference', () => {
    const e = applySedCommands([event('foo')], [sedDir('x', 's/(o)/\\\\1/g')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('f\\1\\1');
  });

  it('applies multiple SEDCMD classes in ASCII order', () => {
    // class "a" runs before class "b": a turns X→Y, then b turns Y→Z.
    const e = applySedCommands([event('X')], [sedDir('b', 's/Y/Z/'), sedDir('a', 's/X/Y/')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('Z');
  });

  it('ignores a y/// whose two sets are different lengths, and says so', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = applySedCommands([event('abc')], [sedDir('x', 'y/abc/XY/')], runCtx(FIXED_NOW, diags))[0]!;
    expect(e._raw).toBe('abc');
    expect(diags.some((d) => d.message.includes('same length'))).toBe(true);
  });

  it('resolves escapes inside a y/// set', () => {
    const e = applySedCommands([event('a\tb')], [sedDir('x', 'y/\\t/ /')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('a b');
  });

  it('transliterates regex metacharacters literally', () => {
    const e = applySedCommands([event('a.b-c')], [sedDir('x', 'y/.-/_+/')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('a_b+c');
  });

  it('warns that the numeric occurrence flag (s/.../.../N) is not simulated', () => {
    const diags: ValidationDiagnostic[] = [];
    applySedCommands([event('a a a')], [sedDir('x', 's/a/b/2')], runCtx(FIXED_NOW, diags));
    expect(diags.some((d) => d.message.includes('numeric occurrence flag'))).toBe(true);
  });
});

// Not Splunk behaviour: sedPattern is the engine's own accessor, so these pin
// that it reads the pattern the expression parser compiles.
describe('sedPattern', () => {
  it('returns the s/// regex with its backslashes, for any delimiter', () => {
    expect(sedPattern(' s/\\d{4}/xxxx/g ')).toBe('\\d{4}');
    expect(sedPattern('s#a\\#b#c#')).toBe('a\\#b');
    expect(sedPattern('s/a/b/')).toBe('a');
    // An empty regex is still a closed field: the delimiter right after `s/`
    // ends it rather than being read as part of it.
    expect(sedPattern('s//x/')).toBe('');
  });

  it('returns null where there is no regex to compile', () => {
    expect(sedPattern('y/abc/xyz/')).toBeNull();
    expect(sedPattern('not sed')).toBeNull();
    expect(sedPattern('s/unclosed')).toBeNull();
    // The replacement must be closed too (#477): parseSedExpression ignores this.
    expect(sedPattern('s/a/b')).toBeNull();
    expect(sedPattern('')).toBeNull();
  });

  it('reads the pattern applySedCommands applies', () => {
    const value = 's/\\d{4}/####/';
    expect(sedPattern(value)).toBe('\\d{4}');
    const [out] = applySedCommands([event('year 2024 here')], [sedDir('m', value)], runCtx(FIXED_NOW, []));
    expect(out?._raw).toBe('year #### here');
  });
});

// Each command is attributed under its own class name (#511: the parsed command
// used to carry an empty className that the caller then overwrote).
describe('applySedCommands — trace attribution', () => {
  it('names each trace step after the SEDCMD class that changed the event', () => {
    const e = applySedCommands(
      [event('card 1234 user bob')],
      [sedDir('mask', 's/\\d{4}/XXXX/'), sedDir('scrub', 'y/bob/BOB/')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(e._raw).toBe('card XXXX user BOB');
    expect(e.processingTrace.map((t) => t.processor)).toEqual(['SEDCMD-mask', 'SEDCMD-scrub']);
  });

  it('records no step for a command that changed nothing', () => {
    const e = applySedCommands([event('abc')], [sedDir('miss', 's/zzz/y/')], runCtx(FIXED_NOW))[0]!;
    expect(e.processingTrace).toEqual([]);
  });

  it('runs classes in name order and labels a class-less SEDCMD with the bare prefix', () => {
    const noClass: ConfDirective = { key: 'SEDCMD', value: 's/a/b/', line: 1, directiveType: 'SEDCMD' };
    const e = applySedCommands([event('a')], [sedDir('z', 's/b/c/'), noClass], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('c');
    expect(e.processingTrace.map((t) => t.processor)).toEqual(['SEDCMD-', 'SEDCMD-z']);
  });
});

// Not Splunk behaviour: what the engine records about each SEDCMD, which the
// trace panel, the raw-diff view and the no-op list read.
describe('applySedCommands — what it records', () => {
  it('records each rewrite after the steps and mutations the event already had', () => {
    const prior = makeEvent('a-b', {
      processingTrace: [{ processor: 'LINE_BREAKER', phase: 'index-time', description: 'split' }],
      rawMutations: [{ traceIndex: 0, rawBefore: 'q', rawAfter: 'r' }],
    });
    const e = applySedCommands([prior], [sedDir('two', 's/b/B/'), sedDir('one', 's/a/A/')], runCtx(FIXED_NOW))[0]!;
    expect(e.rawMutations).toEqual([
      { traceIndex: 0, rawBefore: 'q', rawAfter: 'r' },
      { traceIndex: 1, rawBefore: 'a-b', rawAfter: 'A-b' },
      { traceIndex: 2, rawBefore: 'A-b', rawAfter: 'A-B' },
    ]);
    expect(e.processingTrace).toEqual([
      { processor: 'LINE_BREAKER', phase: 'index-time', description: 'split' },
      {
        processor: 'SEDCMD-one',
        phase: 'index-time',
        description: 'Applied sed substitution',
        inputSnapshot: 'a-b',
        outputSnapshot: 'A-b',
      },
      {
        processor: 'SEDCMD-two',
        phase: 'index-time',
        description: 'Applied sed substitution',
        inputSnapshot: 'A-b',
        outputSnapshot: 'A-B',
      },
    ]);
    expect(e.noOps).toBeUndefined();
  });

  it('starts the list of raw mutations on an event that had none', () => {
    const e = applySedCommands([event('a')], [sedDir('x', 's/a/b/')], runCtx(FIXED_NOW))[0]!;
    expect(e.rawMutations).toEqual([{ traceIndex: 0, rawBefore: 'a', rawAfter: 'b' }]);
  });

  it('returns the events it was given when no SEDCMD parses', () => {
    const input = event('abc');
    const [out] = applySedCommands([input], [sedDir('x', 'not sed')], runCtx(FIXED_NOW));
    expect(out).toBe(input);
  });

  it('returns the events it was given when there is no SEDCMD', () => {
    const input = event('abc');
    const other: ConfDirective = { key: 'TRUNCATE', value: '10', line: 1, directiveType: 'TRUNCATE' };
    const [out] = applySedCommands([input], [other], runCtx(FIXED_NOW));
    expect(out).toBe(input);
  });

  it('names the directive, its line and its stage in a no-op, after the no-ops the event had', () => {
    const earlier = {
      directive: 'EXTRACT-a',
      file: 'props.conf' as const,
      line: 2,
      phase: 'search-time' as const,
      reason: { kind: 'no-match' as const },
    };
    const dir: ConfDirective = { ...sedDir('miss', 'y/z/Z/'), line: 7 };
    const e = applySedCommands([makeEvent('abc', { noOps: [earlier] })], [dir], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('abc');
    expect(e.noOps).toEqual([
      earlier,
      { directive: 'SEDCMD-miss', file: 'props.conf', line: 7, phase: 'index-time', reason: { kind: 'no-match' } },
    ]);
  });

  it('says a pattern matched when the replacement wrote the same text back (#875)', () => {
    const e = applySedCommands([event('id=7')], [sedDir('same', 's/id=(\\d)/id=\\1/')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe('id=7');
    expect(e.noOps?.map((n) => n.reason)).toEqual([{ kind: 'replacement-identical' }]);
  });

  it('explains where a pattern that did not match stopped agreeing', () => {
    const e = applySedCommands([event('user=bob')], [sedDir('m', 's/user=alice/x/')], runCtx(FIXED_NOW))[0]!;
    expect(e.noOps?.[0]?.reason).toEqual({ kind: 'no-match', partialEnd: 5, partialPattern: 'user=' });
  });

  it('says a pattern stopped at a PCRE limit rather than that it did not match', () => {
    const subject = `${'a'.repeat(30)}b`;
    const e = applySedCommands([event(subject)], [sedDir('slow', 's/^(a+)+$/x/')], runCtx(FIXED_NOW))[0]!;
    expect(e._raw).toBe(subject);
    const reason = e.noOps?.[0]?.reason;
    expect(e.noOps).toHaveLength(1);
    expect(reason?.kind).toBe('regex-limit');
    expect(reason?.kind === 'regex-limit' ? reason.error : '').toMatch(/limit/);
  });

  it('reports a parse problem once per run, however many events it meets', () => {
    const diags: ValidationDiagnostic[] = [];
    applySedCommands([event('a'), event('b'), event('c')], [sedDir('x', 's/a')], runCtx(FIXED_NOW, diags));
    expect(diags).toHaveLength(1);
  });

  it('keeps apart the same problem on two lines, or in two layers', () => {
    const at = (line: number, layer?: string): ConfDirective => ({
      ...sedDir('x', 's/a'),
      line,
      ...(layer !== undefined ? { layer } : {}),
    });
    const diags: ValidationDiagnostic[] = [];
    applySedCommands([event('a')], [at(1), at(2), at(2, 'default'), at(2, 'local')], runCtx(FIXED_NOW, diags));
    expect(diags.map((d) => [d.line, d.layer])).toEqual([
      [1, undefined],
      [2, undefined],
      [2, 'default'],
      [2, 'local'],
    ]);
  });
});

// Not Splunk behaviour: the MCP server's static lint calls the parser with no
// directive, and may pass no list for the warnings.
describe('parseSedExpression without a directive', () => {
  it('names no class in a warning', () => {
    const diags: ValidationDiagnostic[] = [];
    expect(parseSedExpression('nope', undefined, { push: (...d) => diags.push(...d) })).toBeNull();
    expect(diags.map((d) => [d.message.slice(0, 15), d.directiveKey, d.line])).toEqual([
      ['SEDCMD-: "nope"', undefined, undefined],
    ]);
  });

  it.each(['nope', 's/a', 'y/ab/c/', 's/(/x/'])('returns null for %s with no list to warn into', (value) => {
    expect(parseSedExpression(value)).toBeNull();
  });

  it('still compiles an expression with a numeric flag and no list to warn into', () => {
    expect(parseSedExpression('s/a/b/2')?.global).toBe(false);
  });
});

// Not Splunk behaviour: the wording and the location of the warnings, which the
// editor shows on the directive's line.
describe('applySedCommands — warnings', () => {
  function warnings(value: string, dir: Partial<ConfDirective> = {}): ValidationDiagnostic[] {
    const diags: ValidationDiagnostic[] = [];
    applySedCommands([event('abc')], [{ ...sedDir('x', value), line: 4, ...dir }], runCtx(FIXED_NOW, diags));
    return diags;
  }

  it('says what a sed expression looks like, at the directive', () => {
    expect(warnings('nope', { layer: 'local' })).toEqual([
      {
        level: 'warning',
        message:
          'SEDCMD-x: "nope" is not a sed expression and was ignored. SEDCMD takes ' +
          's/<regex>/<replacement>/<flags> (any non-alphanumeric character may be the delimiter).',
        file: 'props.conf',
        line: 4,
        layer: 'local',
        directiveKey: 'SEDCMD-x',
      },
    ]);
  });

  it('names the missing delimiter, in the form the expression used', () => {
    expect(warnings('s#a#b').map((d) => d.message)).toEqual([
      'SEDCMD-x: "s#a#b" is missing its closing delimiter "#" and was ignored. SEDCMD takes s#<regex>#<replacement>#<flags>.',
    ]);
  });

  it('gives both lengths of a y/// whose sets differ', () => {
    expect(warnings('y/abc/XY/').map((d) => d.message)).toEqual([
      'SEDCMD-x: y/// needs both character sets to be the same length (got 3 and 2), so the directive was ignored.',
    ]);
  });

  it('says which match a numeric occurrence flag replaces instead', () => {
    expect(warnings('s/a/b/2').map((d) => d.message)).toEqual([
      'SEDCMD-x: the numeric occurrence flag (s/.../.../N) is not simulated — the preview replaces the first match instead of only the Nth.',
    ]);
    expect(warnings('s/a/b/2g').map((d) => d.message)).toEqual([
      'SEDCMD-x: the numeric occurrence flag (s/.../.../N) is not simulated — the preview replaces the matches globally instead of only the Nth.',
    ]);
  });

  it('says a pattern that does not compile was skipped', () => {
    expect(warnings('s/(/x/').map((d) => d.message)).toEqual([
      expect.stringMatching(
        /^SEDCMD-x: the pattern \(\(\) does not compile \(.+\)\. The substitution was skipped, so the event is shown unmodified\.$/,
      ),
    ]);
  });

  it('says nothing about an expression it applies', () => {
    expect(warnings('s/a/b/g')).toEqual([]);
  });
});

// sed's own semantics, for the parts of an expression the tests above do not reach.
describe('applySedCommands — sed edge cases', () => {
  const sub = (value: string, raw: string) =>
    applySedCommands([event(raw)], [sedDir('x', value)], runCtx(FIXED_NOW))[0]!._raw;

  it('replaces only the first match without the g flag', () => {
    expect(sub('s/a/b/', 'a a')).toBe('b a');
  });

  it('reads \\9 as the ninth group', () => {
    expect(sub('s/(a)(b)(c)(d)(e)(f)(g)(h)(i)/\\9/', 'abcdefghi')).toBe('i');
  });

  it('writes nothing for a group that did not take part in the match', () => {
    expect(sub('s/(a)|(b)/[\\1\\2]/g', 'ab')).toBe('[a][b]');
  });

  it('gives a character repeated in a y/// source set its first mapping', () => {
    expect(sub('y/aa/xy/', 'aaa')).toBe('xxx');
  });

  it('resolves \\n, \\r, an escaped delimiter and any other escape inside a y/// set', () => {
    expect(sub('y/\\n\\r\\/\\q/NR|Q/', 'a\nb\rc/dq')).toBe('aNbRc|dQ');
  });

  it('ignores a y/// with empty sets', () => {
    const input = event('abc');
    const [out] = applySedCommands([input], [sedDir('x', 'y///')], runCtx(FIXED_NOW));
    expect(out).toBe(input);
  });

  it('keeps every character a y/// set does not name', () => {
    expect(sub('y/a/b/', 'xyz a')).toBe('xyz b');
  });
});
