import type { ReactNode } from 'react';
import { DialogButton, DialogFooter, DialogFrame, DialogHeader } from './DialogFrame';

/**
 * A yes/no confirmation in the app's dialog style (`DialogFrame`), rather than
 * window.confirm: that one blocks the page, cannot be themed, and reads to a
 * screen reader as whatever the browser chrome says.
 *
 * Radix focuses the first control on open, which is Cancel: the safe answer is
 * the one Enter or Space picks by accident.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <DialogFrame
      open={open}
      onClose={onCancel}
      label={title}
      role="alertdialog"
      // The consequence is what the dialog is FOR, so it is the description a
      // screen reader hears on open. The visible copy below is hidden from the
      // accessibility tree so it is not announced a second time.
      description={children}
      // The dialog is already named by `title` (the Overlay's Title).
      header={<DialogHeader icon="warning" iconClassName="text-[var(--color-warning)]" title={title} titleHidden />}
      footer={
        <DialogFooter>
          <DialogButton variant="cancel" onClick={onCancel}>Cancel</DialogButton>
          <DialogButton variant="danger" onClick={onConfirm}>{confirmLabel}</DialogButton>
        </DialogFooter>
      }
    >
      <div aria-hidden="true" className="p-4 text-sm" style={{ color: 'var(--color-text-secondary)' }}>{children}</div>
    </DialogFrame>
  );
}
