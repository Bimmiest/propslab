import { describe, it, expect } from 'vitest';
import { applySedCommands } from '../processors/sedCmd';
import type { ConfDirective, SplunkEvent, ValidationDiagnostic } from '../types';
import { runCtx } from './runCtx';

const ev = (raw: string): SplunkEvent => ({
  _raw: raw, _time: null, _meta: {}, fields: {},
  metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
  lineNumbers: { start: 1, end: 1 }, processingTrace: [],
});
const sed = (value: string, className = 'x'): ConfDirective =>
  ({ key: `SEDCMD-${className}`, value, line: 1, directiveType: 'SEDCMD', className });

function run(value: string, raw: string) {
  const diagnostics: ValidationDiagnostic[] = [];
  const event = applySedCommands([ev(raw)], [sed(value)], runCtx(diagnostics))[0]!;
  return { raw: event._raw, diagnostics };
}

// `\0` is the whole match; `$0` is not a JS substitution, so mapping to it
// would write the marker itself into the event text.
describe('SEDCMD replacement — whole-match references (#121)', () => {
  it('\\0 expands to the whole match', () => {
    expect(run('s/b/[\\0]/', 'abc').raw).toBe('a[b]c');
  });

  it('a bare & expands to the whole match, as in sed', () => {
    expect(run('s/b/[&]/', 'abc').raw).toBe('a[b]c');
  });

  it('\\& is a literal ampersand', () => {
    expect(run('s/b/[\\&]/', 'abc').raw).toBe('a[&]c');
  });

  it('numbered backreferences still work', () => {
    expect(run('s/(a)(b)/\\2\\1/', 'abc').raw).toBe('bac');
  });

  it('a literal $ survives', () => {
    expect(run('s/b/$X/', 'abc').raw).toBe('a$Xc');
  });
});

// A pattern safeRegex refuses is reported.
describe('SEDCMD — an uncompilable pattern warns rather than vanishing (#122)', () => {
  it('runs a backtracking-prone pattern rather than refusing it (#368)', () => {
    const { raw, diagnostics } = run('s/(a+)+$/Z/', 'aaaa');
    expect(raw).toBe('Z');
    expect(diagnostics).toEqual([]);
  });

  it('warns when the pattern is not valid regex, with PCRE\'s reason', () => {
    const { raw, diagnostics } = run('s/[unclosed/Z/', 'abc');
    expect(raw).toBe('abc');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.level).toBe('warning');
    expect(diagnostics[0]!.message).toMatch(/does not compile \(missing terminating \]/);
    expect(diagnostics[0]!.directiveKey).toBe('SEDCMD-x');
  });
});

// Ordinary values that merely start like a sed command are not read as one.
describe('SEDCMD — command detection requires a real delimiter (#126)', () => {
  it('does not report "yes" as y/// transliteration', () => {
    const { diagnostics } = run('yes', 'abc');
    expect(diagnostics.some((d) => /transliteration/.test(d.message))).toBe(false);
    expect(diagnostics.some((d) => /is not a sed expression/.test(d.message))).toBe(true);
  });

  it('does not parse "something" as a substitution delimited by "o"', () => {
    const { raw, diagnostics } = run('something', 'abc');
    expect(raw).toBe('abc');
    expect(diagnostics.some((d) => /is not a sed expression/.test(d.message))).toBe(true);
  });

  it('still recognises genuine y/// transliteration', () => {
    const { raw, diagnostics } = run('y/abc/ABC/', 'abc');
    expect(raw).toBe('ABC');
    expect(diagnostics).toHaveLength(0);
  });

  it('accepts a non-slash delimiter', () => {
    expect(run('s#b#Z#', 'abc').raw).toBe('aZc');
  });

  it('warns when the closing delimiter is missing', () => {
    const { raw, diagnostics } = run('s/b', 'abc');
    expect(raw).toBe('abc');
    expect(diagnostics.some((d) => /missing its closing delimiter/.test(d.message))).toBe(true);
  });

  it('an empty value is silently ignored', () => {
    expect(run('   ', 'abc').diagnostics).toHaveLength(0);
  });
});
