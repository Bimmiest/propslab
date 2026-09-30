import { describe, it, expect } from 'vitest';
import { computeDiagnostics } from '../splunkConfDiagnostics';
import { parseConf } from '../../engine/parser/confParser';
import { fakeModel } from '../../test/fakeModel';

// The linter and confParser agree on what a directive line is: DIRECTIVE_RE
// rejects a key that starts with whitespace, so an indented line gets the
// malformed-line marker. The two validators sit side by side in the UI.
describe('computeDiagnostics — agrees with confParser on what a directive is (#124)', () => {
  it('flags an indented directive, as the engine does', () => {
    const text = '[st]\n  KV_MODE = json\n';
    const engineErrors = parseConf(text, 'props.conf').errors;
    const markers = computeDiagnostics(fakeModel(text), 'props.conf');

    expect(engineErrors.some((e) => /Malformed line/.test(e.message))).toBe(true);
    expect(markers.some((m) => m.startLineNumber === 2 && /Malformed line/.test(m.message))).toBe(true);
  });

  it('explains why indentation is not a continuation', () => {
    const markers = computeDiagnostics(fakeModel('[st]\n  KV_MODE = json\n'), 'props.conf');
    expect(markers.find((m) => m.startLineNumber === 2)?.message).toMatch(/trailing backslash/);
  });

  it('still accepts an ordinary directive', () => {
    const markers = computeDiagnostics(fakeModel('[st]\nKV_MODE = json\n'), 'props.conf');
    expect(markers.filter((m) => /Malformed line/.test(m.message))).toHaveLength(0);
  });

  it('still accepts a real backslash continuation on the following line', () => {
    const markers = computeDiagnostics(fakeModel('[st]\nTIME_FORMAT = %Y \\\n%m %d'), 'props.conf');
    expect(markers.some((m) => m.startLineNumber === 3)).toBe(false);
  });

  it('flags a line with no "=" at all', () => {
    const markers = computeDiagnostics(fakeModel('[st]\ngarbage\n'), 'props.conf');
    expect(markers.some((m) => m.startLineNumber === 2 && /Malformed line/.test(m.message))).toBe(true);
  });
});

// The checks are per stanza, so directives in unrelated stanzas cannot satisfy
// each other's conditions.
describe('computeDiagnostics — best-practice checks are stanza-scoped (#125)', () => {
  const linemergeWarning = (markers: { message: string }[]) =>
    markers.filter((m) => /SHOULD_LINEMERGE = false/.test(m.message));
  const timeFormatWarning = (markers: { message: string }[]) =>
    markers.filter((m) => /Set TIME_FORMAT when using TIME_PREFIX/.test(m.message));

  it('does not let another stanza satisfy SHOULD_LINEMERGE', () => {
    const text = [
      '[sourcetype_a]',
      'LINE_BREAKER = ([\\r\\n]+)#',
      '',
      '[sourcetype_b]',
      'SHOULD_LINEMERGE = false',
    ].join('\n');
    const warnings = linemergeWarning(computeDiagnostics(fakeModel(text), 'props.conf'));
    expect(warnings).toHaveLength(1);
  });

  it('anchors the warning on the offending stanza, not the first match in the file', () => {
    const text = [
      '[a]',
      'SHOULD_LINEMERGE = false',
      'LINE_BREAKER = ([\\r\\n]+)#',
      '',
      '[b]',
      'LINE_BREAKER = ([\\r\\n]+)#',
    ].join('\n');
    const markers = computeDiagnostics(fakeModel(text), 'props.conf');
    const warnings = linemergeWarning(markers) as unknown as { startLineNumber: number }[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.startLineNumber).toBe(6); // stanza [b]'s LINE_BREAKER
  });

  it('does not let another stanza satisfy TIME_FORMAT', () => {
    const text = ['[a]', 'TIME_PREFIX = ^', '', '[b]', 'TIME_FORMAT = %Y-%m-%d'].join('\n');
    expect(timeFormatWarning(computeDiagnostics(fakeModel(text), 'props.conf'))).toHaveLength(1);
  });

  it('stays quiet when the pair is in the same stanza', () => {
    const text = ['[a]', 'TIME_PREFIX = ^', 'TIME_FORMAT = %Y-%m-%d'].join('\n');
    expect(timeFormatWarning(computeDiagnostics(fakeModel(text), 'props.conf'))).toHaveLength(0);
  });

  it('warns once per offending stanza', () => {
    const text = ['[a]', 'TIME_PREFIX = ^', '', '[b]', 'TIME_PREFIX = ^'].join('\n');
    expect(timeFormatWarning(computeDiagnostics(fakeModel(text), 'props.conf'))).toHaveLength(2);
  });

  it('does not apply props.conf rules to transforms.conf', () => {
    const text = '[t]\nTIME_PREFIX = ^\n';
    expect(timeFormatWarning(computeDiagnostics(fakeModel(text), 'transforms.conf'))).toHaveLength(0);
  });
});

// The linter and the engine give the same mis-cased-attribute answer ("did you
// mean TIME_FORMAT?"): both are shown at once, and a vaguer "possible typo?"
// would send the user to check spelling that is only wrong in its casing.
describe('computeDiagnostics — agrees with confParser on mis-cased attributes (#89)', () => {
  it('gives the same message the engine gives', () => {
    const text = '[st]\ntime_format = %s\n';
    const engineWarning = parseConf(text, 'props.conf').errors.find((e) => /case-sensitive/.test(e.message));
    const marker = computeDiagnostics(fakeModel(text), 'props.conf').find((m) => /case-sensitive/.test(m.message));

    expect(engineWarning).toBeDefined();
    expect(marker?.message).toBe(engineWarning?.message);
  });

  it('flags it as a warning rather than an informational typo note', () => {
    const markers = computeDiagnostics(fakeModel('[st]\ntime_format = %s\n'), 'props.conf');
    expect(markers.some((m) => /possible typo/.test(m.message))).toBe(false);
    expect(markers.find((m) => /case-sensitive/.test(m.message))?.severity).toBe(4);
  });

  it('agrees on a mis-cased class prefix too', () => {
    const text = '[st]\nextract-f = (?<a>\\w+)\n';
    const engineWarning = parseConf(text, 'props.conf').errors.find((e) => /case-sensitive/.test(e.message));
    const marker = computeDiagnostics(fakeModel(text), 'props.conf').find((m) => /case-sensitive/.test(m.message));
    expect(marker?.message).toBe(engineWarning?.message);
  });

  it('agrees that a correctly-cased attribute is fine', () => {
    const text = '[st]\nTIME_FORMAT = %s\n';
    expect(parseConf(text, 'props.conf').errors.filter((e) => /case-sensitive/.test(e.message))).toEqual([]);
    expect(computeDiagnostics(fakeModel(text), 'props.conf').filter((m) => /case-sensitive/.test(m.message))).toEqual(
      [],
    );
  });
});

// Found by diagnosticsParityProperties.test.ts: lines the two validators read
// differently.
describe('computeDiagnostics — agrees with confParser on line structure (#371)', () => {
  const malformedLines = (text: string) => ({
    engine: parseConf(text, 'props.conf')
      .errors.filter((e) => e.level === 'error')
      .map((e) => e.line),
    linter: computeDiagnostics(fakeModel(text), 'props.conf')
      .filter((m) => m.severity === 8)
      .map((m) => m.startLineNumber),
  });

  it('reads a broken header holding "=" as a broken header, not a directive keyed "[x"', () => {
    const text = '[x=y]\\\nk1 = v\n';
    expect(
      parseConf(text, 'props.conf')
        .stanzas.flatMap((s) => s.directives)
        .map((d) => d.key),
    ).toEqual(['k1']);
    expect(malformedLines(text)).toEqual({ engine: [1], linter: [1] });
  });

  it('flags an empty stanza header in both', () => {
    expect(malformedLines('[]\n')).toEqual({ engine: [1], linter: [1] });
  });

  it('flags an indented comment or header in both, as it does an indented directive', () => {
    expect(malformedLines('  # note\n\t[s]\n')).toEqual({ engine: [1, 2], linter: [1, 2] });
  });

  it('does not continue a value whose backslash is followed by whitespace', () => {
    const text = '[s]\nk1 = a\\ \nk2 = b\n';
    const unknown = computeDiagnostics(fakeModel(text), 'props.conf')
      .filter((m) => /^Unknown directive/.test(m.message))
      .map((m) => m.startLineNumber);
    expect(parseConf(text, 'props.conf').stanzas[0]!.directives.map((d) => d.line)).toEqual([2, 3]);
    expect(unknown).toEqual([2, 3]);
  });
});
