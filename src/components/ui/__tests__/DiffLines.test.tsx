// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DiffLines } from '../DiffLines';
import { computeDiff } from '../../../utils/diffEngine';

describe('DiffLines', () => {
  it('renders one row per line, signed by whether it was kept, removed or added', () => {
    const { container } = render(
      <div>
        <DiffLines diff={computeDiff('a\nb\nc', 'a\nB\nc')} />
      </div>,
    );
    const rows = Array.from(container.firstElementChild!.children);
    const signed = rows.map((row) => `${row.children[0]!.textContent}${row.children[1]!.textContent}`);
    expect(signed).toEqual([' a', '-b', '+B', ' c']);
    expect(rows[1]!.className).toContain('bg-[var(--color-error)]/10');
    expect(rows[2]!.className).toContain('bg-[var(--color-success)]/10');
    expect(rows[0]!.className).toBe('flex');
  });
});
