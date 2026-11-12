// ---------------------------------------------------------------------------
// HeaderMenu.tsx
// The header's settings, pipeline reference and theme buttons, in one menu
// for a header too narrow to show them in a row (#893).
// ---------------------------------------------------------------------------

import { useCallback, useId, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useTheme } from '../../hooks/useTheme';
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss';
import { Icon, type IconName } from '../ui/Icon';

function MenuButton({
  icon,
  label,
  pressed,
  onClick,
}: {
  icon: IconName;
  label: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className="w-full flex items-center gap-3 px-3 py-2 text-left text-xs cursor-pointer outline-none text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] focus-visible:bg-[var(--color-bg-tertiary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
    >
      <Icon name={icon} className="w-4 h-4 shrink-0 text-[var(--color-text-secondary)]" />
      <span className="flex-1">{label}</span>
      {pressed && <Icon name="check" className="w-3.5 h-3.5 shrink-0 text-[var(--color-accent)]" />}
    </button>
  );
}

/**
 * A disclosure, as ExamplesMenu is: a list of buttons that Tab walks, not an
 * ARIA menu with an arrow-key model. A choice closes it and gives the focus
 * back to its trigger, so the focus is not lost with the list.
 */
export function HeaderMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const close = useCallback(() => setOpen(false), []);
  const dismiss = usePopoverDismiss(ref, triggerRef, open, close);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const helpOpen = useAppStore((s) => s.helpOpen);
  const toggleHelp = useAppStore((s) => s.toggleHelp);
  const { theme, toggleTheme } = useTheme();

  const choose = (action: () => void) => () => {
    close();
    triggerRef.current?.focus();
    action();
  };

  return (
    // The wrapper listens for keys and focus bubbling up from its own controls;
    // it is not itself interactive.
    <div ref={ref} className="relative" {...dismiss}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="More"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        className="flex items-center justify-center w-8 h-8 rounded-md border-none outline-none focus-visible:ring-2 press cursor-pointer text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
      >
        <Icon name="more" className="w-[18px] h-[18px]" />
      </button>
      {open && (
        <div
          id={popupId}
          role="group"
          aria-label="More"
          className="motion-pop-in absolute right-0 top-full mt-1 z-50 w-56 py-1 rounded-lg border shadow-lg origin-top-right"
          style={{ backgroundColor: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
        >
          <MenuButton icon="settings" label="Settings" pressed={settingsOpen} onClick={choose(toggleSettings)} />
          <MenuButton icon="info" label="Pipeline reference" pressed={helpOpen} onClick={choose(toggleHelp)} />
          <MenuButton
            icon={theme === 'dark' ? 'sun' : 'moon'}
            label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={choose(toggleTheme)}
          />
        </div>
      )}
    </div>
  );
}
