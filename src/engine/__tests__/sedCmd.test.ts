import { describe, it, expect } from 'vitest';
import { applySedCommands } from '../processors/sedCmd';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';

function event(raw: string): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

function sedDir(className: string, value: string): ConfDirective {
  return { key: `SEDCMD-${className}`, value, line: 1, directiveType: 'SEDCMD', className };
}

describe('applySedCommands', () => {
  it('performs a basic substitution', () => {
    const e = applySedCommands([event('hello world')], [sedDir('x', 's/world/there/')])[0]!;
    expect(e._raw).toBe('hello there');
  });

  it('honours the global flag', () => {
    const e = applySedCommands([event('a a a')], [sedDir('x', 's/a/b/g')])[0]!;
    expect(e._raw).toBe('b b b');
  });

  it('uses sed backreferences (\\1) in the replacement', () => {
    const e = applySedCommands([event('id=42')], [sedDir('x', 's/id=(\\d+)/user-\\1/')])[0]!;
    expect(e._raw).toBe('user-42');
  });

  // A literal `$` in the replacement is a substitution pattern in JS, so it is
  // escaped (e.g. $5 must not become part of capture-ref handling).
  it('treats a literal $ in the replacement as literal', () => {
    const e = applySedCommands([event('price')], [sedDir('x', 's/price/$5.00/')])[0]!;
    expect(e._raw).toBe('$5.00');
  });

  // An escaped delimiter in the replacement drops the backslash (GNU sed:
  // `echo abc | sed 's/b/x\/y/'` → `ax/yc`), rather than leaving a stray `\`.
  it('unescapes an escaped delimiter in the replacement', () => {
    const e = applySedCommands([event('abc')], [sedDir('x', 's/b/x\\/y/')])[0]!;
    expect(e._raw).toBe('ax/yc');
  });

  it('unescapes a doubled backslash to a single backslash', () => {
    const e = applySedCommands([event('a')], [sedDir('x', 's/a/x\\\\y/')])[0]!;
    expect(e._raw).toBe('x\\y');
  });

  // A backslash-escaped backslash before a digit is a literal backslash, not a
  // backreference: `\\1` → literal `\1`, never capture group 1.
  it('does not treat an escaped backslash before a digit as a backreference', () => {
    const e = applySedCommands([event('foo')], [sedDir('x', 's/(o)/\\\\1/g')])[0]!;
    expect(e._raw).toBe('f\\1\\1');
  });

  it('applies multiple SEDCMD classes in ASCII order', () => {
    // class "a" runs before class "b": a turns X→Y, then b turns Y→Z.
    const e = applySedCommands([event('X')], [sedDir('b', 's/Y/Z/'), sedDir('a', 's/X/Y/')])[0]!;
    expect(e._raw).toBe('Z');
  });

  // Capture-derived: the Splunk 10.4.0 capture `sedcmd-transliterate`.
  it('applies y/// transliteration to every occurrence', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = applySedCommands([event('abcdef abc')], [sedDir('x', 'y/abc/ABC/')], diags)[0]!;
    // Inside a longer word as well as standalone, and `def` untouched.
    expect(e._raw).toBe('ABCdef ABC');
    expect(diags).toHaveLength(0);
  });

  it('ignores a y/// whose two sets are different lengths, and says so', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = applySedCommands([event('abc')], [sedDir('x', 'y/abc/XY/')], diags)[0]!;
    expect(e._raw).toBe('abc');
    expect(diags.some((d) => d.message.includes('same length'))).toBe(true);
  });

  it('resolves escapes inside a y/// set', () => {
    const e = applySedCommands([event('a\tb')], [sedDir('x', 'y/\\t/ /')])[0]!;
    expect(e._raw).toBe('a b');
  });

  it('transliterates regex metacharacters literally', () => {
    const e = applySedCommands([event('a.b-c')], [sedDir('x', 'y/.-/_+/')])[0]!;
    expect(e._raw).toBe('a_b+c');
  });

  it('warns that the numeric occurrence flag (s/.../.../N) is not simulated', () => {
    const diags: ValidationDiagnostic[] = [];
    applySedCommands([event('a a a')], [sedDir('x', 's/a/b/2')], diags);
    expect(diags.some((d) => d.message.includes('numeric occurrence flag'))).toBe(true);
  });
});
