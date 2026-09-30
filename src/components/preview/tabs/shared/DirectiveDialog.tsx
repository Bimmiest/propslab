import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DialogButton, DialogFooter, DialogFrame, DialogHeader } from '../../../ui/DialogFrame';

/**
 * Shared shell for the "scaffold from selection" dialogs (Create EXTRACT,
 * Set TIME_PREFIX): `DialogFrame` with Esc, Enter-to-apply and an Apply
 * button. The caller supplies the body (inputs + preview) and the apply logic.
 */
export function DirectiveDialog({
  title,
  applyLabel,
  applyDisabled,
  onApply,
  onClose,
  children,
}: {
  title: string;
  applyLabel: string;
  applyDisabled: boolean;
  onApply: () => void;
  onClose: () => void;
  children: ReactNode;
}) {

  /**
   * Enter submits from the dialog's inputs, but must not hijack an activation
   * the user aimed at a control: Enter on a focused Cancel button must
   * cancel, not have this container handler preventDefault() the button's
   * activation and write the directive into props.conf.
   * Ignore Enter during IME composition to avoid submitting partially-typed characters.
   */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Enter' || applyDisabled) return;
    if (e.nativeEvent.isComposing) return;
    if (e.target instanceof HTMLElement && e.target.closest('button, a, textarea')) return;
    e.preventDefault();
    onApply();
  };

  return (
    <DialogFrame
      onClose={onClose}
      label={title}
      onKeyDown={onKeyDown}
      header={<DialogHeader icon="sparkles" iconClassName="text-[var(--color-accent)]" title={title} />}
      footer={
        <DialogFooter>
          <DialogButton variant="cancel" onClick={onClose}>Cancel</DialogButton>
          <DialogButton variant="accent" onClick={onApply} disabled={applyDisabled}>{applyLabel}</DialogButton>
        </DialogFooter>
      }
    >
      <div className="p-4 space-y-3">{children}</div>
    </DialogFrame>
  );
}
