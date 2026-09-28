// The window arithmetic behind the virtualized Fields table and sidebar (#454).
import { describe, it, expect } from 'vitest';
import { computeWindow, type WindowSegment } from '../useWindowedRows';

const rowIndexes = (segs: WindowSegment[]) => segs.flatMap((s) => (s.kind === 'row' ? [s.index] : []));
const totalHeight = (segs: WindowSegment[], rowHeight: number) =>
  segs.reduce((sum, s) => sum + (s.kind === 'row' ? rowHeight : s.height), 0);

describe('computeWindow', () => {
  it('renders every row at or below the threshold', () => {
    const segs = computeWindow(100, 5000, 300, 20, 5, 100, null);
    expect(rowIndexes(segs)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(segs.every((s) => s.kind === 'row')).toBe(true);
  });

  it('renders the rows in view plus the overscan, with spacers for the rest', () => {
    // 300px of 20px rows from 2000px: rows 100–114 in view.
    const segs = computeWindow(1000, 2000, 300, 20, 5, 100, null);
    const rows = rowIndexes(segs);
    expect(rows[0]).toBe(95);
    expect(rows.at(-1)).toBe(119);
    expect(segs[0]).toEqual({ kind: 'spacer', key: 'before', height: 95 * 20 });
    // The spacers keep the scroll height the full list would have.
    expect(totalHeight(segs, 20)).toBe(1000 * 20);
  });

  it('starts at the top, with no leading spacer', () => {
    const segs = computeWindow(1000, 0, 300, 20, 5, 100, null);
    expect(segs[0]).toEqual({ kind: 'row', index: 0 });
    expect(totalHeight(segs, 20)).toBe(20_000);
  });

  it('renders the last rows for a scroll position past the end (a list that just shrank)', () => {
    const segs = computeWindow(1000, 1e7, 300, 20, 5, 100, null);
    const rows = rowIndexes(segs);
    expect(rows.at(-1)).toBe(999);
    expect(totalHeight(segs, 20)).toBe(20_000);
    const nearEnd = rowIndexes(computeWindow(1000, 19_700, 300, 20, 5, 100, null));
    expect(nearEnd.at(-1)).toBe(999);
  });

  it('assumes a viewport before layout, so the first paint is not empty', () => {
    expect(rowIndexes(computeWindow(1000, 0, 0, 20, 0, 100, null)).length).toBe(40);
  });

  it('keeps a focused row rendered after the window has moved past it', () => {
    const below = computeWindow(1000, 10_000, 300, 20, 5, 100, 10);
    expect(rowIndexes(below)).toContain(10);
    expect(totalHeight(below, 20)).toBe(20_000);
    const above = computeWindow(1000, 0, 300, 20, 5, 100, 900);
    expect(rowIndexes(above)).toContain(900);
    expect(totalHeight(above, 20)).toBe(20_000);
    // Rows stay in document order, so Tab order matches the list.
    const rows = rowIndexes(below);
    expect([...rows].sort((a, b) => a - b)).toEqual(rows);
  });

  it('ignores a pinned row already in the window, or no longer in the list', () => {
    const plain = computeWindow(1000, 2000, 300, 20, 5, 100, null);
    expect(computeWindow(1000, 2000, 300, 20, 5, 100, 100)).toEqual(plain);
    expect(computeWindow(1000, 2000, 300, 20, 5, 100, 5000)).toEqual(plain);
  });
});
