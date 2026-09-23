// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// MultiSelect.test.tsx
// The popup is a disclosure over a checkbox group (#300): it has to say so,
// and it has to get out of the way when focus leaves it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MultiSelect } from '../MultiSelect';

function setup(selected = new Set<string>()) {
  const onChange = vi.fn();
  render(
    <>
      <MultiSelect label="Status" options={['Accepted', 'Dropped']} selected={selected} onChange={onChange} />
      <button type="button">elsewhere</button>
    </>,
  );
  const trigger = screen.getByRole('button', { name: /Status/ });
  return { trigger, onChange };
}

describe('MultiSelect', () => {
  it('is a disclosure controlling a checkbox group, not a listbox', () => {
    const { trigger } = setup();
    expect(trigger).not.toHaveAttribute('aria-haspopup');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'Status options' });
    expect(trigger).toHaveAttribute('aria-controls', group.id);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const box = screen.getAllByRole('checkbox')[0]!;
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });

    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when focus moves outside it', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const box = screen.getAllByRole('checkbox')[0]!;
    fireEvent.blur(box, { relatedTarget: screen.getByRole('button', { name: 'elsewhere' }) });
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('stays open when focus moves within it', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const [a, b] = screen.getAllByRole('checkbox');
    fireEvent.blur(a!, { relatedTarget: b });
    expect(screen.getByRole('group')).toBeInTheDocument();
  });

  it('keeps focus on the trigger after Clear all removes itself', () => {
    const { trigger, onChange } = setup(new Set(['Dropped']));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onChange).toHaveBeenCalledWith(new Set());
    expect(document.activeElement).toBe(trigger);
  });
});
