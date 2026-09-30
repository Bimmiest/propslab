// @vitest-environment jsdom
// The confirmation is an alertdialog: it is named by its title, described by
// its consequence, and answered with a button rather than a stray click (#495).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '../ConfirmDialog';

function renderDialog(props: { onConfirm?: () => void; onCancel?: () => void } = {}) {
  return render(
    <ConfirmDialog
      open
      title="Replace your current work?"
      confirmLabel="Replace"
      onConfirm={props.onConfirm ?? (() => {})}
      onCancel={props.onCancel ?? (() => {})}
    >
      Loading replaces everything you have now.
    </ConfirmDialog>,
  );
}

describe('ConfirmDialog', () => {
  it('is named by its title and described by the consequence', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: 'Replace your current work?' });
    expect(dialog).toHaveAccessibleDescription('Loading replaces everything you have now.');
  });

  it('hides the visible copy of the title and consequence from the accessibility tree', () => {
    renderDialog();
    // The sr-only Title and Description carry them; announcing the visible
    // duplicates as well would read each twice.
    const copies = screen.getAllByText('Replace your current work?');
    expect(copies).toHaveLength(2);
    expect(copies.filter((el) => el.closest('[aria-hidden="true"]'))).toHaveLength(1);
  });

  it('does not dismiss on a click outside the dialog', async () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    // Radix arms its outside-press listener on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0 });
    fireEvent.click(document.body);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels on Escape and on the Cancel button', () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
