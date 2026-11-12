// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// ContextMenu.test.tsx
// Shift+F10 and the Menu key open the shared context menu from the keyboard
// (#933). Safari sends no contextmenu event for them, so the trigger sends
// one; Chromium and Firefox send their own as well, which must not open the
// menu a second time.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import type React from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ContextMenu';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  // Lets a guard that a test left armed expire, so it cannot reach the next test.
  act(() => {
    vi.runAllTimers();
  });
  vi.useRealTimers();
  cleanup();
});

/** The browser's own contextmenu event, as Chromium sends it for the key. */
function browserMenuEvent(target: Element) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function renderMenu({
  disabled,
  onOpenChange = vi.fn(),
  onContextMenu = vi.fn(),
  onKeyDown,
}: {
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
} = {}) {
  render(
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger disabled={disabled}>
        <div onContextMenu={onContextMenu}>
          <button type="button" onKeyDown={onKeyDown}>
            row
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => {}}>Copy</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
  const row = screen.getByRole('button', { name: 'row' });
  act(() => row.focus());
  return { row, onOpenChange, onContextMenu };
}

const shiftF10 = { key: 'F10', shiftKey: true };

describe('ContextMenuTrigger from the keyboard', () => {
  it('opens on Shift+F10 when the browser sends no contextmenu event, as Safari does', () => {
    const { row, onOpenChange } = renderMenu();
    const sent = fireEvent.keyDown(row, shiftF10);
    expect(sent).toBe(false);
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('opens on the Menu key', () => {
    const { row } = renderMenu();
    fireEvent.keyDown(row, { key: 'ContextMenu' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('opens once when the browser also sends its own event, as Chromium does', () => {
    const { row, onOpenChange, onContextMenu } = renderMenu();
    fireEvent.keyDown(row, shiftF10);
    const browsers = browserMenuEvent(row);
    // Cancelled, so the browser shows no menu of its own, and never reaches the trigger.
    expect(browsers.defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it("swallows only one event of the browser's, so a right-click after it opens the menu", () => {
    const { row, onContextMenu } = renderMenu();
    fireEvent.keyDown(row, shiftF10);
    browserMenuEvent(row);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(browserMenuEvent(row).defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });

  it("swallows the browser's event that comes with the keyup, as on Windows", () => {
    const { row, onContextMenu } = renderMenu();
    fireEvent.keyDown(row, { key: 'ContextMenu' });
    // Held past the time a keydown alone keeps the guard for: the keyup is what counts.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    fireEvent.keyUp(row, { key: 'ContextMenu' });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(browserMenuEvent(row).defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it('lets a right-click through 250 ms after the keyup', () => {
    const { row, onContextMenu } = renderMenu();
    fireEvent.keyDown(row, { key: 'ContextMenu' });
    fireEvent.keyUp(row, { key: 'ContextMenu' });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    browserMenuEvent(row);
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });

  it('lets a right-click through at once, since it starts with a pointerdown', () => {
    const { row, onContextMenu } = renderMenu();
    fireEvent.keyDown(row, shiftF10);
    fireEvent.pointerDown(row, { button: 2 });
    browserMenuEvent(row);
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });

  it('keeps the guard after the keyup of another key', () => {
    const { row, onContextMenu } = renderMenu();
    fireEvent.keyDown(row, shiftF10);
    fireEvent.keyUp(row, { key: 'Shift' });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    browserMenuEvent(row);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it('lets a right-click through after 2 s when no keyup comes', () => {
    const { row, onContextMenu } = renderMenu();
    fireEvent.keyDown(row, shiftF10);
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    browserMenuEvent(row);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    browserMenuEvent(row);
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });

  it('starts a new guard on each press, and the old one stops nothing', () => {
    const { row, onContextMenu } = renderMenu();
    fireEvent.keyDown(row, shiftF10);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    fireEvent.keyDown(row, shiftF10);
    // The first guard's 2 s are over, the second one's are not.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(browserMenuEvent(row).defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });

  it('sends the event to the focused element, at its bottom-left corner inside the viewport', () => {
    const { row, onContextMenu } = renderMenu();
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 40, y: 10, width: 100, height: 20 }));
    fireEvent.keyDown(row, shiftF10);
    expect(onContextMenu).toHaveBeenCalledWith(expect.objectContaining({ target: row, clientX: 40, clientY: 30 }));

    act(() => {
      vi.runAllTimers();
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: -50, y: window.innerHeight - 10, width: 100, height: 40 }),
    );
    fireEvent.keyDown(row, shiftF10);
    expect(onContextMenu).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientX: 0, clientY: window.innerHeight }),
    );
  });

  it.each([
    ['F10 alone', { key: 'F10' }],
    ['Ctrl+Shift+F10', { key: 'F10', shiftKey: true, ctrlKey: true }],
    ['Alt+Shift+F10', { key: 'F10', shiftKey: true, altKey: true }],
    ['Cmd+Shift+F10', { key: 'F10', shiftKey: true, metaKey: true }],
    ['Shift+F9', { key: 'F9', shiftKey: true }],
  ])('leaves %s alone', (_name, init) => {
    const { row, onContextMenu } = renderMenu();
    expect(fireEvent.keyDown(row, init)).toBe(true);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // No guard either: a right-click still reaches the trigger.
    browserMenuEvent(row);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it('leaves the key to a control inside the trigger that uses it', () => {
    const { row, onContextMenu } = renderMenu({ onKeyDown: (e) => e.preventDefault() });
    fireEvent.keyDown(row, shiftF10);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('leaves the key to the browser while the trigger is disabled', () => {
    const { row, onContextMenu } = renderMenu({ disabled: true });
    expect(fireEvent.keyDown(row, shiftF10)).toBe(true);
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('opens only the inner menu of two nested triggers', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <ContextMenu onOpenChange={outer}>
        <ContextMenuTrigger>
          <div>
            <ContextMenu onOpenChange={inner}>
              <ContextMenuTrigger>
                <button type="button">cell</button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => {}}>Inner</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => {}}>Outer</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'cell' }), shiftF10);
    expect(inner).toHaveBeenCalledExactlyOnceWith(true);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'Inner' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Outer' })).not.toBeInTheDocument();
  });
});
