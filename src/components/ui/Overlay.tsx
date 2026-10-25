// ---------------------------------------------------------------------------
// Overlay.tsx
// One overlay implementation, backed by @radix-ui/react-dialog: an Escape
// layer stack so only the topmost overlay closes, a Tab focus trap and
// background inertness, plus the tail a bespoke trap tends not to cover —
// scroll lock, `pointer-events` during enter/exit, returning focus to the
// trigger after a portal unmounts, and iOS Safari's handling of `inert`.
//
// It is a wrapper rather than five direct usages so the backdrop, the z-index
// and the dismiss-on-outside-click behaviour stay identical across overlays.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

export interface OverlayProps {
  open: boolean;
  /**
   * Called when Escape is pressed, the backdrop is clicked, or focus escapes.
   * An `alertdialog` ignores the backdrop click: a confirmation is answered
   * with one of its buttons (or Escape), not dismissed by a stray click.
   */
  onClose: () => void;
  /** Accessible name for the dialog. */
  label: string;
  children: ReactNode;
  /**
   * Applied to the content element, which sits above the backdrop. It places
   * the content itself (`fixed`, `z-50`): there is no layout wrapper around
   * it, because Radix gives each child of the portal its own Presence, and a
   * wrapper with no exit animation unmounts at once and takes the content's
   * exit animation with it (#696).
   */
  className?: string;
  /** Inline styles for the content element. */
  style?: React.CSSProperties;
  /** Fires on the content element; used for Enter-to-submit in a form dialog. */
  onKeyDown?: (event: React.KeyboardEvent) => void;
  /** `alertdialog` for a confirmation that interrupts the user's flow. */
  role?: 'dialog' | 'alertdialog';
  /**
   * Text for the dialog's accessible description, read after its name. Rendered
   * visually hidden and linked with `aria-describedby`; leave it out when the
   * name says everything, rather than inventing a sentence for the reader.
   */
  description?: ReactNode;
}

export function Overlay({
  open,
  onClose,
  label,
  children,
  className,
  style,
  onKeyDown,
  role,
  description,
}: OverlayProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/*
        Never force-mounted, not even for the sliding pipeline reference: closed
        content left in the tree keeps a Radix DismissableLayer alive, and its
        capture-phase Escape handler then swallows Escape for the whole app. An
        overlay that animates does so with `data-state` keyframes, which Radix's
        Presence waits out before unmounting.
      */}
      <Dialog.Portal>
        <Dialog.Overlay className="motion-fade fixed inset-0 z-40" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }} />
        <Dialog.Content
          className={className}
          style={style}
          onKeyDown={onKeyDown}
          {...(role ? { role } : {})}
          {...(role === 'alertdialog' ? { onPointerDownOutside: (e: Event) => e.preventDefault() } : {})}
          // Radix requires either a description or an explicit opt-out.
          // Without a `description`, opting out is the accurate answer
          // rather than inventing a sentence for a screen reader to read.
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          {/*
            The accessible name. A bare `aria-label` would name the dialog
            just as well, but Radix warns for a Content with no Title — and a
            console error on every overlay is a real cost, not a lint nit.
          */}
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          {description !== undefined && <Dialog.Description className="sr-only">{description}</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
