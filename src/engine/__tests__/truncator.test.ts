import { describe, it, expect } from 'vitest';
import { truncateEvents } from '../processors/truncator';
import { breakLines } from '../processors/lineBreaker';
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

function truncateDir(value: string): ConfDirective[] {
  return [{ key: 'TRUNCATE', value, line: 1, directiveType: 'TRUNCATE' }];
}

describe('truncateEvents', () => {
  it('truncates events longer than the byte limit', () => {
    const e = truncateEvents([event('abcdefghij')], truncateDir('5'))[0]!;
    expect(e._raw).toBe('abcde');
  });

  it('leaves shorter events untouched', () => {
    const e = truncateEvents([event('abc')], truncateDir('100'))[0]!;
    expect(e._raw).toBe('abc');
  });

  it('TRUNCATE = 0 disables truncation', () => {
    const long = 'x'.repeat(50);
    const e = truncateEvents([event(long)], truncateDir('0'))[0]!;
    expect(e._raw).toBe(long);
  });

  // BUG-1: a non-numeric TRUNCATE used to slice every event to '' via NaN.
  it('ignores a non-numeric TRUNCATE instead of blanking every event', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = truncateEvents([event('keep me intact')], truncateDir('abc'), diags)[0]!;
    expect(e._raw).toBe('keep me intact');
    expect(diags.some((d) => d.message.includes('not a valid byte count'))).toBe(true);
  });

  // #67.1: TRUNCATE is a per-line cap, not a per-(merged-)event cap.
  it('leaves a long multi-line event intact when every line is under the limit', () => {
    // 6 lines × 8 chars = 48 bytes total, well over TRUNCATE=20, but each line
    // is only 8 bytes. Splunk truncates per line, so nothing is cut.
    const raw = Array.from({ length: 6 }, (_, i) => `line-${i}0`).join('\n');
    const e = truncateEvents([event(raw)], truncateDir('20'))[0]!;
    expect(e._raw).toBe(raw);
  });

  it('truncates only the individual lines that exceed the limit', () => {
    const raw = ['short', 'this-line-is-way-too-long', 'ok'].join('\n');
    const e = truncateEvents([event(raw)], truncateDir('5'))[0]!;
    expect(e._raw).toBe(['short', 'this-', 'ok'].join('\n'));
  });

  // #67.2: mid-character truncation must round down to a full UTF-8 character,
  // not emit a U+FFFD replacement character for the trailing partial sequence.
  it('rounds down to a UTF-8 character boundary instead of emitting U+FFFD', () => {
    // '€' is 3 bytes (E2 82 AC); "a€" is 4 bytes. A 2-byte cut must drop the
    // whole '€' and yield "a", not "a�".
    const e = truncateEvents([event('a€')], truncateDir('2'))[0]!;
    expect(e._raw).toBe('a');
    expect(e._raw).not.toContain('�');
  });

  it('keeps a multi-byte character that fits exactly within the limit', () => {
    // "€€" is 6 bytes; a 3-byte cut keeps exactly one '€'.
    const e = truncateEvents([event('€€')], truncateDir('3'))[0]!;
    expect(e._raw).toBe('€');
    expect(e._raw).not.toContain('�');
  });

  // #30.2: parseInt is too lenient — these forms must be rejected, not silently
  // truncating with a wrong length (1e3→1) or disabling truncation (0x10→0).
  it.each(['0x10', '1e3', '100abc', '1.5', '-5'])(
    'ignores a malformed TRUNCATE value %s',
    (bad) => {
      const diags: ValidationDiagnostic[] = [];
      const long = 'x'.repeat(50);
      const e = truncateEvents([event(long)], truncateDir(bad), diags)[0]!;
      expect(e._raw).toBe(long); // unchanged
      expect(diags.some((d) => d.message.includes('not a valid byte count'))).toBe(true);
    },
  );
});

// Doc-derived (props.conf.spec): TRUNCATE is "the default maximum line length",
// and LINE_BREAKER is what delimits a line — "the start of the first capturing
// group [is] the end of the previous line". So a line is a LINE_BREAKER segment,
// before merging, and may contain newlines. Not a captured fixture.
describe('#287 — TRUNCATE caps LINE_BREAKER segments, not newline-separated pieces', () => {
  const META = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
  const d = (key: string, value: string): ConfDirective => ({ key, value, line: 1, directiveType: key });

  it('cuts a multi-line JSON record kept in one segment by a custom LINE_BREAKER', () => {
    const record = '{\n  "a": "0123456789",\n  "b": "0123456789"\n}';
    const directives = [d('SHOULD_LINEMERGE', 'false'), d('LINE_BREAKER', '(\\n)(?=\\{)'), d('TRUNCATE', '20')];
    const events = truncateEvents(breakLines(`${record}\n${record}`, directives, META), directives);
    expect(events).toHaveLength(2);
    // Every '\n'-piece is under 20 bytes, so the old per-'\n' reading left
    // both records whole.
    expect(events.map((e) => e._raw)).toEqual([record.slice(0, 20), record.slice(0, 20)]);
    expect(events.every((e) => e.fields['meta'] === 'truncated')).toBe(true);
  });

  it('still caps each merged line on its own under the default LINE_BREAKER', () => {
    // SHOULD_LINEMERGE defaults to true: single-line segments are merged into
    // one event after being capped, so a long merged event of short lines is
    // left alone and only the over-long line is cut.
    const raw = '2026-01-15T10:00:00Z start\nshort\n' + 'x'.repeat(50) + '\nshort';
    const directives = [d('TRUNCATE', '30')];
    const [e] = truncateEvents(breakLines(raw, directives, META), directives);
    expect(e!._raw).toBe('2026-01-15T10:00:00Z start\nshort\n' + 'x'.repeat(30) + '\nshort');
  });

  it('caps each segment separately when merged segments themselves span newlines', () => {
    // A breaker that splits on `;\n` keeps `a\nb` style pairs as one segment;
    // merging then joins those segments. Each segment is its own line.
    const raw = `${'p'.repeat(8)}\n${'q'.repeat(8)};\n${'r'.repeat(4)}`;
    const directives = [
      d('LINE_BREAKER', ';(\\n)'),
      d('BREAK_ONLY_BEFORE_DATE', 'false'),
      d('TRUNCATE', '12'),
    ];
    const [e] = truncateEvents(breakLines(raw, directives, META), directives);
    expect(e!._raw).toBe(`${'p'.repeat(8)}\n${'q'.repeat(3)}\n${'r'.repeat(4)}`);
  });

  it('falls back to newline-separated lines for an event breakLines did not build', () => {
    const e = truncateEvents([event('abcdefgh\nab')], truncateDir('4'))[0]!;
    expect(e._raw).toBe('abcd\nab');
  });
});
