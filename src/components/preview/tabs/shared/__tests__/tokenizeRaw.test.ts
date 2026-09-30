import { describe, it, expect } from 'vitest';
import { tokenizeRaw } from '../tokenizeRaw';

describe('tokenizeRaw', () => {
  it('reproduces the input when segments are concatenated', () => {
    const raw = '192.168.1.10 - frank [10/Oct/2000:13:55:36 -0700] "GET /a.html"';
    expect(
      tokenizeRaw(raw)
        .map((s) => s.text)
        .join(''),
    ).toBe(raw);
  });

  it('keeps a dotted-quad IP as a single selectable token', () => {
    const segs = tokenizeRaw('192.168.1.10');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ text: '192.168.1.10', start: 0, end: 12, selectable: true });
  });

  it('splits key=value on the = delimiter', () => {
    const segs = tokenizeRaw('status=200');
    expect(segs.map((s) => [s.text, s.selectable])).toEqual([
      ['status', true],
      ['=', false],
      ['200', true],
    ]);
  });

  it('exposes an Apache timestamp and offset as adjacent tokens around the gap', () => {
    const segs = tokenizeRaw('[10/Oct/2000:13:55:36 -0700]');
    const tokens = segs.filter((s) => s.selectable).map((s) => s.text);
    expect(tokens).toEqual(['10/Oct/2000:13:55:36', '-0700']);
    // Offsets let a shift-click range cover the timestamp + space + offset.
    const ts = segs.find((s) => s.text === '10/Oct/2000:13:55:36')!;
    const off = segs.find((s) => s.text === '-0700')!;
    expect('[10/Oct/2000:13:55:36 -0700]'.slice(ts.start, off.end)).toBe('10/Oct/2000:13:55:36 -0700');
  });

  it('treats whitespace and newlines as gaps', () => {
    const segs = tokenizeRaw('a\nb');
    expect(segs.map((s) => [s.text, s.selectable])).toEqual([
      ['a', true],
      ['\n', false],
      ['b', true],
    ]);
  });

  it('handles an empty string', () => {
    expect(tokenizeRaw('')).toEqual([]);
  });
});
