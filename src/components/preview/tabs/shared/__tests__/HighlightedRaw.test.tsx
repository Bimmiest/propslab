// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// HighlightedRaw.test.tsx
// The highlighted values of an Extractions card from the keyboard (#882): one
// tab stop per card, the arrow keys between the values, Enter pins, and
// Shift+F10 opens the field menu of that value through the card's one menu.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { HighlightedTab } from '../../HighlightedTab';
import type { EnrichedEvent } from '../../../enrichEvents';
import { useAppStore } from '../../../../../store/useAppStore';
import { makeEvent } from '../../../../../test/makeEvent';
import { fieldTargetOf, rovingIndex } from '../fieldSpans';

const copied = vi.hoisted(() => vi.fn());
vi.mock('../../../../../utils/clipboard', () => ({ copyQuietly: copied }));

const initial = useAppStore.getState();

function item(raw: string, fields: Record<string, string>): EnrichedEvent {
  const event = makeEvent(raw, {
    fields,
    processingTrace: [
      { processor: 'EXTRACT-kv', phase: 'search-time', description: '', fieldsAdded: Object.keys(fields) },
    ],
  });
  return { event, searchText: raw, originalRaw: raw, hasChanges: false, hasMetadataChanges: false, isDropped: false };
}

const items = [
  item('user=alice action=login status=ok', { user: 'alice', action: 'login', status: 'ok' }),
  item('user=bob action=logout', { user: 'bob', action: 'logout' }),
];

function renderTab() {
  return render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
}

/** The highlighted values of the nth card, in text order. */
function valuesOf(card: number): HTMLElement[] {
  const pre = document.querySelectorAll('pre')[card];
  if (!pre) throw new Error(`no card ${card}`);
  return Array.from(pre.querySelectorAll<HTMLElement>('[data-field]'));
}

beforeEach(() => {
  useAppStore.setState(initial, true);
  copied.mockClear();
});

describe('highlighted values from the keyboard (#882)', () => {
  it('are buttons with the field in their name', () => {
    renderTab();
    const [user] = valuesOf(0);
    expect(user).toHaveAttribute('role', 'button');
    expect(user).toHaveAccessibleName('user (manual): alice');
    expect(user).toHaveAccessibleDescription(/arrow keys move between the fields/);
    expect(user).toHaveAttribute('aria-pressed', 'false');
  });

  it('give each card one tab stop, on its first value', () => {
    renderTab();
    for (const card of [0, 1]) {
      const tabIndexes = valuesOf(card).map((v) => v.tabIndex);
      expect(tabIndexes[0]).toBe(0);
      expect(tabIndexes.slice(1).every((t) => t === -1)).toBe(true);
    }
  });

  it('move the focus and the tab stop with the arrow keys, Home and End, and stop at the ends', () => {
    renderTab();
    const [user, action, status] = valuesOf(0);
    user!.focus();
    fireEvent.keyDown(user!, { key: 'ArrowRight' });
    expect(action).toHaveFocus();
    expect(action!.tabIndex).toBe(0);
    expect(user!.tabIndex).toBe(-1);

    fireEvent.keyDown(action!, { key: 'End' });
    expect(status).toHaveFocus();
    fireEvent.keyDown(status!, { key: 'ArrowRight' });
    expect(status).toHaveFocus();

    fireEvent.keyDown(status!, { key: 'Home' });
    expect(user).toHaveFocus();
    fireEvent.keyDown(user!, { key: 'ArrowLeft' });
    expect(user).toHaveFocus();
    // The other card keeps its own tab stop.
    expect(valuesOf(1)[0]!.tabIndex).toBe(0);
  });

  it('focus the field on focus, as a hover does', () => {
    renderTab();
    const [, action] = valuesOf(0);
    fireEvent.focus(action!);
    // Every value of another field dims; both `action` values stay lit.
    expect(valuesOf(0)[0]!.style.opacity).toBe('0.2');
    expect(valuesOf(1)[1]!.style.opacity).toBe('1');
    fireEvent.blur(action!);
    expect(valuesOf(0)[0]!.style.opacity).toBe('1');
  });

  it('pin the field on Enter or Space, and unpin it again', () => {
    renderTab();
    const [, action] = valuesOf(0);
    fireEvent.keyDown(action!, { key: 'Enter' });
    expect(screen.getByText(/2\/2 events match 1 pinned field/)).toBeInTheDocument();
    expect(valuesOf(0)[1]).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(valuesOf(0)[1]!, { key: ' ' });
    expect(screen.queryByText(/pinned field/)).not.toBeInTheDocument();
  });

  it('do nothing for another key', () => {
    renderTab();
    const [user] = valuesOf(0);
    user!.focus();
    fireEvent.keyDown(user!, { key: 'a' });
    expect(user).toHaveFocus();
    expect(screen.queryByText(/pinned field/)).not.toBeInTheDocument();
  });
});

describe("the card's one context menu (#882)", () => {
  it('opens the field menu of the value it was opened on, with that value', () => {
    renderTab();
    const action = valuesOf(1)[1]!;
    // Shift+F10 alone, with no contextmenu event from the browser, as in
    // Safari (#933): the trigger sends one to the focused value.
    action.focus();
    fireEvent.keyDown(action, { key: 'F10', shiftKey: true });
    // Chromium sends its own event for the key as well; it opens no second menu.
    fireEvent.contextMenu(action);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('action')).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy value' }));
    expect(copied).toHaveBeenCalledWith('logout');
  });

  it('pins from the menu, and names the pin both ways', () => {
    renderTab();
    fireEvent.contextMenu(valuesOf(0)[0]!);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Pin field' }));
    expect(screen.getByText(/2\/2 events match 1 pinned field/)).toBeInTheDocument();

    fireEvent.contextMenu(valuesOf(0)[0]!);
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Unpin field' })).toBeInTheDocument();
  });

  it('opens the event menu on the rest of the card', () => {
    renderTab();
    fireEvent.contextMenu(screen.getAllByText(/Event #/)[0]!);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Copy event' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Copy value' })).not.toBeInTheDocument();
  });

  it('is one menu for the card, not one per value', () => {
    renderTab();
    // A Radix trigger marks its element with data-state; the values are not triggers.
    for (const value of [...valuesOf(0), ...valuesOf(1)]) expect(value).not.toHaveAttribute('data-state');
  });
});

describe('fieldTargetOf', () => {
  function card(html: string): HTMLElement {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
  }

  it('reads the field, the value and the pin off the value', () => {
    const div = card('<span data-field="user" data-value="a, b" aria-pressed="true"><b>a</b></span>');
    expect(fieldTargetOf(div.querySelector('b'), div)).toEqual({ field: 'user', value: 'a, b', pinned: true });
  });

  it('falls back to the text for a value with no data-value', () => {
    const div = card('<span data-field="user">alice</span>');
    expect(fieldTargetOf(div.querySelector('span'), div)).toEqual({ field: 'user', value: 'alice', pinned: false });
  });

  it('is null off a value, outside the container, and for a target that is not an element', () => {
    const outer = card('<span data-field="user"><i>x</i><div id="inner"></div></span><p>plain</p>');
    const inner = outer.querySelector<HTMLElement>('#inner')!;
    expect(fieldTargetOf(outer.querySelector('p'), outer)).toBeNull();
    expect(fieldTargetOf(outer.querySelector('i'), inner)).toBeNull();
    expect(fieldTargetOf(null, outer)).toBeNull();
    expect(fieldTargetOf(document, outer)).toBeNull();
  });
});

describe('rovingIndex', () => {
  it.each([
    ['ArrowRight', 1, 2],
    ['ArrowRight', 2, 2],
    ['ArrowLeft', 1, 0],
    ['ArrowLeft', 0, 0],
    ['Home', 2, 0],
    ['End', 0, 2],
    ['ArrowDown', 1, null],
    ['Tab', 1, null],
  ])('%s from %i of 3 goes to %s', (key, from, to) => {
    expect(rovingIndex(key, from, 3)).toBe(to);
  });
});
