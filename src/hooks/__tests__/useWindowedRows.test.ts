// The window arithmetic behind the virtualized Fields table and sidebar (#454).
import { describe, it, expect } from 'vitest';
import { computeWindow, type WindowSegment } from '../useWindowedRows';

const rowIndexes = (segs: WindowSegment[]) => segs.flatMap((s) => (s.kind === 'row' ? [s.index] : []));
const totalHeight = (segs: WindowSegment[], rowHeight: number) =>
  segs.reduce((sum, s) => sum + (s.kind === 'row' ? rowHeight : s.height), 0);

describe('computeWindow', () => {
  const settings = { viewport: 300, rowHeight: 20, overscan: 5, threshold: 100, pinned: null };

  it('renders every row at or below the threshold', () => {
    const segs = computeWindow(100, { ...settings, scrollTop: 5000 });
    expect(rowIndexes(segs)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(segs.every((s) => s.kind === 'row')).toBe(true);
  });

  it('renders the rows in view plus the overscan, with spacers for the rest', () => {
    // 300px of 20px rows from 2000px: rows 100–114 in view.
    const segs = computeWindow(1000, { ...settings, scrollTop: 2000 });
    const rows = rowIndexes(segs);
    expect(rows[0]).toBe(95);
    expect(rows.at(-1)).toBe(119);
    expect(segs[0]).toEqual({ kind: 'spacer', key: 'before', height: 95 * 20 });
    // The spacers keep the scroll height the full list would have.
    expect(totalHeight(segs, 20)).toBe(1000 * 20);
  });

  it('starts at the top, with no leading spacer', () => {
    const segs = computeWindow(1000, { ...settings, scrollTop: 0 });
    expect(segs[0]).toEqual({ kind: 'row', index: 0 });
    expect(totalHeight(segs, 20)).toBe(20_000);
  });

  it('renders the last rows for a scroll position past the end (a list that just shrank)', () => {
    const segs = computeWindow(1000, { ...settings, scrollTop: 1e7 });
    const rows = rowIndexes(segs);
    expect(rows.at(-1)).toBe(999);
    expect(totalHeight(segs, 20)).toBe(20_000);
    const nearEnd = rowIndexes(computeWindow(1000, { ...settings, scrollTop: 19_700 }));
    expect(nearEnd.at(-1)).toBe(999);
  });

  it('assumes a viewport before layout, so the first paint is not empty', () => {
    expect(rowIndexes(computeWindow(1000, { ...settings, scrollTop: 0, viewport: 0, overscan: 0 })).length).toBe(40);
  });

  it('keeps a focused row rendered after the window has moved past it', () => {
    const below = computeWindow(1000, { ...settings, scrollTop: 10_000, pinned: 10 });
    expect(rowIndexes(below)).toContain(10);
    expect(totalHeight(below, 20)).toBe(20_000);
    const above = computeWindow(1000, { ...settings, scrollTop: 0, pinned: 900 });
    expect(rowIndexes(above)).toContain(900);
    expect(totalHeight(above, 20)).toBe(20_000);
    // Rows stay in document order, so Tab order matches the list.
    const rows = rowIndexes(below);
    expect([...rows].sort((a, b) => a - b)).toEqual(rows);
  });

  it('renders the overscan past a focused row at the edge, before the window has scrolled to it', () => {
    // Rows 95–119 from the scroll position; Tab focused row 118, and the scroll
    // it caused has not re-rendered the window yet.
    const rows = rowIndexes(computeWindow(1000, { ...settings, scrollTop: 2000, pinned: 118 }));
    expect(rows[0]).toBe(95);
    expect(rows.at(-1)).toBe(123);
    expect(rows).toEqual(Array.from({ length: rows.length }, (_, i) => 95 + i));
    // Away from the window, the focused row brings its neighbours too.
    const away = rowIndexes(computeWindow(1000, { ...settings, scrollTop: 10_000, pinned: 10 }));
    expect(away.slice(0, 11)).toEqual(Array.from({ length: 11 }, (_, i) => 5 + i));
  });

  it('ignores a pinned row already in the window, or no longer in the list', () => {
    const plain = computeWindow(1000, { ...settings, scrollTop: 2000 });
    expect(computeWindow(1000, { ...settings, scrollTop: 2000, pinned: 100 })).toEqual(plain);
    expect(computeWindow(1000, { ...settings, scrollTop: 2000, pinned: 5000 })).toEqual(plain);
  });
});
