// ---------------------------------------------------------------------------
// DialogFrame.tsx
// The chrome of the app's centred dialogs — ConfirmDialog, DirectiveDialog and
// ScaffoldModal: the elevated panel, a header bar with an icon and a title, a
// footer of right-aligned buttons, and the buttons themselves. One copy, so
// the three cannot drift apart. What goes between header and footer is the
// caller's.
// ---------------------------------------------------------------------------

import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Overlay } from './Overlay';

const PANEL_STYLE = { backgroundColor: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' };

const SIZES = {
  /** A short form or a question. */
  md: {
    container: 'fixed inset-0 z-50 flex items-start justify-center pt-[20vh] px-4',
    panel: 'w-full max-w-md rounded-xl overflow-hidden shadow-2xl',
  },
  /** A body that scrolls between a fixed header and footer. */
  lg: {
    container: 'fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4',
    panel: 'w-full max-w-3xl max-h-[80vh] flex flex-col rounded-xl overflow-hidden shadow-2xl',
  },
} as const;

export interface DialogFrameProps {
  open?: boolean;
  onClose: () => void;
  /** The dialog's accessible name. */
  label: string;
  role?: 'dialog' | 'alertdialog';
  description?: ReactNode;
  onKeyDown?: (event: KeyboardEvent) => void;
  size?: keyof typeof SIZES;
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}

export function DialogFrame({
  open = true,
  onClose,
  label,
  role,
  description,
  onKeyDown,
  size = 'md',
  header,
  footer,
  children,
}: DialogFrameProps) {
  const { container, panel } = SIZES[size];
  return (
    <Overlay
      open={open}
      onClose={onClose}
      label={label}
      role={role}
      description={description}
      onKeyDown={onKeyDown}
      containerClassName={container}
      className={panel}
      style={PANEL_STYLE}
    >
      {/* `contents`, so a flex-column panel lays out the three parts itself. */}
      <div className="contents">
        {header}
        {children}
        {footer}
      </div>
    </Overlay>
  );
}

/**
 * The title bar. `titleHidden` hides the visible title from the accessibility
 * tree, for a dialog whose name the Overlay's own Title already announces and
 * that would otherwise be read twice.
 */
export function DialogHeader({
  icon,
  iconClassName,
  title,
  titleHidden = false,
  children,
}: {
  icon: IconName;
  iconClassName: string;
  title: string;
  titleHidden?: boolean;
  /** Anything after the title: a subtitle, a close button. */
  children?: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 px-4 h-11 shrink-0"
      style={{ borderBottom: '1px solid var(--color-border)' }}
    >
      <Icon name={icon} className={`w-4 h-4 ${iconClassName}`} />
      <span
        {...(titleHidden ? { 'aria-hidden': true } : {})}
        className="text-sm font-semibold"
        style={{ color: 'var(--color-text-primary)' }}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-end gap-2 px-4 py-3 shrink-0"
      style={{ borderTop: '1px solid var(--color-border)' }}
    >
      {children}
    </div>
  );
}

const BUTTON_BASE = 'px-3 py-1.5 text-sm rounded-md cursor-pointer border-none';

const BUTTON_VARIANTS = {
  cancel: {
    className: `${BUTTON_BASE} text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]`,
    style: undefined,
  },
  accent: {
    className: `${BUTTON_BASE} font-medium text-[var(--color-text-on-accent)] disabled:opacity-40 disabled:cursor-not-allowed`,
    style: { backgroundColor: 'var(--color-accent)' },
  },
  danger: {
    className: `${BUTTON_BASE} font-medium text-[var(--color-text-on-error)]`,
    style: { backgroundColor: 'var(--color-error)' },
  },
} as const;

/** A footer button: `cancel` for the way out, `accent` or `danger` for the action. */
export function DialogButton({
  variant,
  ...props
}: { variant: keyof typeof BUTTON_VARIANTS } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'style' | 'type'
>) {
  const { className, style } = BUTTON_VARIANTS[variant];
  return <button type="button" className={className} style={style} {...props} />;
}
