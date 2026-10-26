import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { DialogButton, DialogFooter, DialogFrame, DialogHeader } from '../../../ui/DialogFrame';

/**
 * Shared shell for the "scaffold from selection" dialogs (Create EXTRACT,
 * Set TIME_PREFIX): `DialogFrame` with Esc and a title. Rendered closed rather
 * than not at all, so it can animate out (#702); the caller's form goes inside,
 * where Radix mounts it afresh on each opening and keeps it through the exit.
 */
export function DirectiveDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <DialogFrame
      open={open}
      onClose={onClose}
      label={title}
      header={<DialogHeader icon="sparkles" iconClassName="text-[var(--color-accent)]" title={title} />}
      footer={null}
    >
      {children}
    </DialogFrame>
  );
}

/**
 * A directive dialog's body and its Cancel/Apply footer, with Enter-to-apply.
 * The caller supplies the inputs and preview, and the apply logic.
 */
export function DirectiveForm({
  applyLabel,
  applyDisabled,
  onApply,
  onClose,
  children,
}: {
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
    // `contents`, so the panel's flex column lays out the body and the footer
    // itself; keys from the inputs still bubble here.
    <div className="contents" onKeyDown={onKeyDown}>
      <div className="p-4 space-y-3">{children}</div>
      <DialogFooter>
        <DialogButton variant="cancel" onClick={onClose}>
          Cancel
        </DialogButton>
        <DialogButton variant="accent" onClick={onApply} disabled={applyDisabled}>
          {applyLabel}
        </DialogButton>
      </DialogFooter>
    </div>
  );
}
