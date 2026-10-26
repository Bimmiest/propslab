// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DirectiveDialog, DirectiveForm } from '../DirectiveDialog';

function setup(applyDisabled = false) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <DirectiveDialog open title="Create EXTRACT" onClose={onClose}>
      <DirectiveForm applyLabel="Apply" applyDisabled={applyDisabled} onApply={onApply} onClose={onClose}>
        <input aria-label="Field name" defaultValue="x" />
      </DirectiveForm>
    </DirectiveDialog>,
  );
  return { onApply, onClose };
}

describe('DirectiveDialog — Enter must not hijack a focused control (#71)', () => {
  it('does not apply when Enter is pressed on the Cancel button', () => {
    const { onApply } = setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('does not double-apply when Enter is pressed on the Apply button', () => {
    const { onApply } = setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Apply' }), { key: 'Enter' });
    // The button's own activation handles this; the container must stay out of it.
    expect(onApply).not.toHaveBeenCalled();
  });

  it('still applies when Enter is pressed in an input', () => {
    const { onApply } = setup();
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Enter' });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('does not apply from an input while Apply is disabled', () => {
    const { onApply } = setup(true);
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Enter' });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('Cancel still closes when clicked', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('DirectiveDialog — rendered closed between uses (#702)', () => {
  it('renders nothing while closed, and starts its form afresh on each opening', () => {
    const form = (
      <DirectiveForm applyLabel="Apply" applyDisabled={false} onApply={vi.fn()} onClose={vi.fn()}>
        <input aria-label="Field name" defaultValue="x" />
      </DirectiveForm>
    );
    const { rerender } = render(
      <DirectiveDialog open={false} title="Create EXTRACT" onClose={vi.fn()}>
        {form}
      </DirectiveDialog>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const reopen = (open: boolean) =>
      rerender(
        <DirectiveDialog open={open} title="Create EXTRACT" onClose={vi.fn()}>
          {form}
        </DirectiveDialog>,
      );
    reopen(true);
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'typed' } });
    reopen(false);
    reopen(true);
    expect(screen.getByLabelText('Field name')).toHaveValue('x');
  });
});
