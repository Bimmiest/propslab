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
  /** Called when Escape is pressed, the backdrop is clicked, or focus escapes. */
  onClose: () => void;
  /** Accessible name for the dialog. */
  label: string;
  children: ReactNode;
  /** Applied to the content element, which sits above the backdrop. */
  className?: string;
  /** Inline styles for the content element. */
  style?: React.CSSProperties;
  /** Classes for the full-screen layer holding the content (layout only). */
  containerClassName?: string;
  /**
   * Keep the content mounted while closed, for an overlay that animates itself
   * in and out rather than appearing instantly (the pipeline reference panel
   * slides). Radix still applies inertness and the focus trap only while `open`.
   */
  forceMount?: boolean;
  /** Fires on the content element; used for Enter-to-submit in a form dialog. */
  onKeyDown?: (event: React.KeyboardEvent) => void;
}

export function Overlay({
  open,
  onClose,
  label,
  children,
  className,
  style,
  containerClassName = 'fixed inset-0 z-50 flex items-start justify-center pt-[20vh]',
  forceMount,
  onKeyDown,
}: OverlayProps) {
  return (
    <Dialog.Root
      open={open}
      // Modality is scoped to the open state, which matters only for a
      // force-mounted overlay: left permanently modal, Radix keeps the rest of
      // the app `aria-hidden` while the overlay sits closed in the tree, and
      // every role-based query against the app finds nothing. That is invisible
      // in a unit test of the overlay itself and took out the whole e2e suite.
      modal={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal {...(forceMount ? { forceMount: true } : {})}>
        <Dialog.Overlay
          {...(forceMount ? { forceMount: true } : {})}
          className="fixed inset-0 z-40"
          style={{
            backgroundColor: 'rgba(0,0,0,0.5)',
            // A force-mounted overlay stays in the tree while closed, so it has
            // to stop painting and stop swallowing clicks on its own.
            ...(forceMount && !open ? { opacity: 0, pointerEvents: 'none' } : {}),
          }}
        />
        <div className={containerClassName}>
          <Dialog.Content
            {...(forceMount ? { forceMount: true } : {})}
            className={className}
            style={style}
            onKeyDown={onKeyDown}
            // A force-mounted overlay stays in the tree while closed, so it has
            // to drop itself out of the accessibility tree and the tab order —
            // otherwise a closed slide-out panel is still exposed as a dialog
            // with focusable buttons sitting off-screen.
            {...(forceMount && !open ? { 'aria-hidden': true, inert: true } : {})}
            // These overlays carry no separate descriptive text, and Radix
            // requires either a description or an explicit opt-out. Opting out
            // is the accurate answer rather than inventing a sentence for a
            // screen reader to read out.
            aria-describedby={undefined}
          >
            {/*
              The accessible name. A bare `aria-label` would name the dialog
              just as well, but Radix warns for a Content with no Title — and a
              console error on every overlay is a real cost, not a lint nit.
            */}
            <Dialog.Title className="sr-only">{label}</Dialog.Title>
            {children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
