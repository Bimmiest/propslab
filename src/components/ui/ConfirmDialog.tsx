import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { Overlay } from './Overlay';

/**
 * A yes/no confirmation in the app's dialog style (the DirectiveDialog shell),
 * rather than window.confirm: that one blocks the page, cannot be themed, and
 * reads to a screen reader as whatever the browser chrome says.
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
    <Overlay
      open={open}
      onClose={onCancel}
      label={title}
      role="alertdialog"
      containerClassName="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] px-4"
      className="w-full max-w-md rounded-xl overflow-hidden shadow-2xl"
      style={{ backgroundColor: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
    >
      <div>
        <div className="flex items-center gap-2 px-4 h-11 shrink-0" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <Icon name="warning" className="w-4 h-4 text-[var(--color-warning)]" />
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>{title}</span>
        </div>

        <div className="p-4 text-sm" style={{ color: 'var(--color-text-secondary)' }}>{children}</div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-md cursor-pointer border-none text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm rounded-md cursor-pointer border-none font-medium text-[var(--color-text-on-error)]"
            style={{ backgroundColor: 'var(--color-error)' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
