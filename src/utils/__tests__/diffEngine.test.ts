import { describe, it, expect } from 'vitest';
import { computeDiff } from '../diffEngine';

/**
 * `computeDiff` is a thin pass-through to `diff`'s `diffLines`, which makes it
 * the one place a major bump of that dependency can change behaviour without
 * changing any code here. DiffTab and ScaffoldModal both render straight off
 * these segments, so what is pinned below is the contract they rely on rather
 * than the library's incidental output shape.
 */
describe('computeDiff', () => {
  it('marks an unchanged line as neither added nor removed', () => {
    const segment = computeDiff('same\n', 'same\n')[0]!;
    expect(segment.value).toBe('same\n');
    expect(segment.added).toBeFalsy();
    expect(segment.removed).toBeFalsy();
  });

  it('marks a replaced line as one removal and one addition', () => {
    const segments = computeDiff('a\nb\nc\n', 'a\nX\nc\n');
    expect(segments.filter((s) => s.removed).map((s) => s.value)).toEqual(['b\n']);
    expect(segments.filter((s) => s.added).map((s) => s.value)).toEqual(['X\n']);
  });

  it('reassembles both sides — the invariant the diff views depend on', () => {
    // Concatenating everything not-added must give the original, and everything
    // not-removed must give the modified. A rendering that drops or duplicates a
    // line shows up here and nowhere else.
    const original = 'one\ntwo\nthree\nfour\n';
    const modified = 'one\nTWO\nthree\nfour\nfive\n';
    const segments = computeDiff(original, modified);

    expect(
      segments
        .filter((s) => !s.added)
        .map((s) => s.value)
        .join(''),
    ).toBe(original);
    expect(
      segments
        .filter((s) => !s.removed)
        .map((s) => s.value)
        .join(''),
    ).toBe(modified);
  });

  it('reports a pure addition without inventing a removal', () => {
    const segments = computeDiff('a\n', 'a\nb\n');
    expect(segments.some((s) => s.removed)).toBe(false);
    expect(segments.filter((s) => s.added).map((s) => s.value)).toEqual(['b\n']);
  });

  it('reports a pure deletion without inventing an addition', () => {
    const segments = computeDiff('a\nb\n', 'a\n');
    expect(segments.some((s) => s.added)).toBe(false);
    expect(segments.filter((s) => s.removed).map((s) => s.value)).toEqual(['b\n']);
  });

  it('treats two empty inputs as no change rather than throwing', () => {
    expect(computeDiff('', '').every((s) => !s.added && !s.removed)).toBe(true);
  });

  it('flags every line when the whole text is replaced', () => {
    const segments = computeDiff('old\n', 'new\n');
    expect(segments.filter((s) => s.removed).map((s) => s.value)).toEqual(['old\n']);
    expect(segments.filter((s) => s.added).map((s) => s.value)).toEqual(['new\n']);
  });

  it('always returns string values, since both views concatenate them', () => {
    const segments = computeDiff('a\nb\n', 'b\nc\n');
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => typeof s.value === 'string')).toBe(true);
  });
});
