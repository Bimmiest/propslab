import * as RCM from '@radix-ui/react-context-menu';
import type React from 'react';

/**
 * Token-styled wrappers over @radix-ui/react-context-menu (mirrors how Tooltip
 * wraps radix-tooltip). Radix handles positioning, keyboard nav, portal/collision,
 * and Esc/outside-click dismissal.
 *
 * Usage:
 *   <ContextMenu>
 *     <ContextMenuTrigger><div>right-click me</div></ContextMenuTrigger>
 *     <ContextMenuContent>
 *       <ContextMenuLabel>Field</ContextMenuLabel>
 *       <ContextMenuItem onSelect={…}>Copy value</ContextMenuItem>
 *       <ContextMenuSeparator />
 *       <ContextMenuItem onSelect={…}>Pin field</ContextMenuItem>
 *     </ContextMenuContent>
 *   </ContextMenu>
 */
// A wrapper component rather than `export const ContextMenu = RCM.Root`.
// react-refresh/only-export-components cannot tell that a re-exported binding is
// a component, so the bare alias reads to it as a non-component export and
// disables Fast Refresh for this whole file. Declaring it is also what the other
// five exports here already do.
export function ContextMenu(props: React.ComponentProps<typeof RCM.Root>) {
  // Not modal (#572). Radix's modal menu sets aria-hidden on the rest of the
  // page while it is open, which leaves every focusable control there inside
  // aria-hidden (axe aria-hidden-focus) and hides the page's h1. A menu is not
  // a dialog: Escape and a press outside still close it.
  return <RCM.Root modal={false} {...props} />;
}

// Shift+F10 and the Menu key open the menu here, not in the browser (#933).
// Safari sends no contextmenu event for them, and macOS has no such key, so a
// menu that waits for the browser's event cannot open from the keyboard there.
// The trigger sends the event itself, to the focused element, so a handler
// below the trigger that reads the event's target (the Diff tab's line) sees
// the same event as from a right-click. Chromium and Firefox also send their
// own event for the key, on the keydown or, on Windows, on the keyup. The
// cancelled keydown stops Chromium's on Linux (measured in Playwright), but
// not on every platform, so the guard swallows one that still comes. Without
// it the menu would open a second time, at another point.
const synthesised = new WeakSet<Event>();
// How long after the key comes up the browser's own event can still arrive,
// and the longest the guard waits for that keyup.
const GUARD_AFTER_KEYUP_MS = 250;
const GUARD_MAX_MS = 2000;
let releaseGuard: (() => void) | null = null;

function isMenuKey(e: React.KeyboardEvent): boolean {
  if (e.key === 'ContextMenu') return true;
  return e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
}

function guardBrowserMenu(key: string) {
  releaseGuard?.();
  let timer = 0;
  // The browser sends one event for the key, at most.
  const swallow = (event: MouseEvent) => {
    if (synthesised.has(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    release();
  };
  const release = () => {
    window.clearTimeout(timer);
    window.removeEventListener('contextmenu', swallow, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('pointerdown', release, true);
    if (releaseGuard === release) releaseGuard = null;
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== key) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(release, GUARD_AFTER_KEYUP_MS);
  };
  timer = window.setTimeout(release, GUARD_MAX_MS);
  window.addEventListener('contextmenu', swallow, true);
  window.addEventListener('keyup', onKeyUp, true);
  // A right-click starts with a pointerdown, and a menu key never does.
  window.addEventListener('pointerdown', release, true);
  releaseGuard = release;
}

function openFromKeyboard(e: React.KeyboardEvent<HTMLElement>) {
  // A control inside the trigger that uses the key, or an inner trigger that
  // has opened its own menu, has cancelled it.
  if (e.defaultPrevented || !isMenuKey(e)) return;
  e.preventDefault();
  guardBrowserMenu(e.key);
  const target = e.target instanceof Element ? e.target : e.currentTarget;
  // The bottom-left corner of the focused element, inside the viewport, as
  // Chromium places a menu that the keyboard opens.
  const rect = target.getBoundingClientRect();
  const clientX = Math.min(Math.max(rect.left, 0), window.innerWidth);
  const clientY = Math.min(Math.max(rect.bottom, 0), window.innerHeight);
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX, clientY });
  synthesised.add(event);
  target.dispatchEvent(event);
}

export function ContextMenuTrigger({
  children,
  asChild = true,
  disabled,
}: {
  children: React.ReactNode;
  asChild?: boolean;
  /** Leaves the browser's own menu in place, for a target that is not ready. */
  disabled?: boolean;
}) {
  return (
    <RCM.Trigger asChild={asChild} disabled={disabled} onKeyDown={disabled ? undefined : openFromKeyboard}>
      {children}
    </RCM.Trigger>
  );
}

export function ContextMenuContent({ children }: { children: React.ReactNode }) {
  return (
    <RCM.Portal>
      <RCM.Content
        className="motion-pop origin-(--radix-context-menu-content-transform-origin) z-50 min-w-[11rem] rounded-md py-1 shadow-lg"
        style={{
          backgroundColor: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
        }}
      >
        {children}
      </RCM.Content>
    </RCM.Portal>
  );
}

export function ContextMenuItem({
  children,
  onSelect,
  disabled,
  shortcut,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** The key that does the same outside the menu, shown at the right. Not part of the item's name. */
  shortcut?: string;
}) {
  return (
    <RCM.Item
      disabled={disabled}
      onSelect={onSelect}
      className="group flex items-center gap-2 mx-1 px-2 py-1.5 rounded text-xs cursor-pointer outline-none select-none
        text-[var(--color-text-primary)] data-[highlighted]:bg-[var(--color-accent)] data-[highlighted]:text-[var(--color-text-on-accent)]
        data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed"
    >
      {children}
      {shortcut && (
        <kbd
          aria-hidden="true"
          className="ml-auto pl-6 font-sans text-[var(--color-text-muted)] group-data-[highlighted]:text-[var(--color-text-on-accent)]"
        >
          {shortcut}
        </kbd>
      )}
    </RCM.Item>
  );
}

export function ContextMenuSeparator() {
  return <RCM.Separator className="my-1 h-px" style={{ backgroundColor: 'var(--color-border)' }} />;
}

export function ContextMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <RCM.Label
      className="px-3 py-1 text-xs font-semibold uppercase tracking-wider"
      style={{ color: 'var(--color-text-muted)' }}
    >
      {children}
    </RCM.Label>
  );
}
