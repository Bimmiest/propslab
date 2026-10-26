// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// EditorContextMenu.test.tsx
// The editors' right-click menu (#745), against a REAL Monaco editor (see
// src/test/monacoJsdom.ts): clipboard actions on the selection, the
// directive lookup on a conf line, and the actions shared with the palette.
// ---------------------------------------------------------------------------

import '../../../test/monacoJsdom';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import * as monaco from 'monaco-editor/editor';
import { useAppStore } from '../../../store/useAppStore';

const clipboard = vi.hoisted(() => ({
  copyToClipboard: vi.fn((_text: string) => Promise.resolve()),
  copyQuietly: vi.fn(),
}));
vi.mock('../../../utils/clipboard', () => clipboard);

const { EditorContextMenu } = await import('../EditorContextMenu');

const initial = useAppStore.getState();
beforeEach(() => {
  useAppStore.setState(initial, true);
  clipboard.copyToClipboard.mockClear();
  clipboard.copyQuietly.mockClear();
});
afterEach(() => {
  cleanup();
  for (const model of monaco.editor.getModels()) model.dispose();
});

function openMenu(value: string, file: 'raw' | 'props.conf' | 'transforms.conf', select?: monaco.Selection) {
  const ed = monaco.editor.create(document.createElement('div'), { value, language: 'plaintext' });
  if (select) ed.setSelection(select);
  render(
    <EditorContextMenu editor={ed} file={file}>
      <div>editor body</div>
    </EditorContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText('editor body'));
  return { ed, menu: screen.getByRole('menu') };
}

const item = (menu: HTMLElement, name: string | RegExp) => within(menu).getByRole('menuitem', { name });

describe('EditorContextMenu', () => {
  it('leaves the browser menu in place until the editor exists', () => {
    render(
      <EditorContextMenu editor={null} file="raw">
        <div>editor body</div>
      </EditorContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('editor body'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('copies the selection, and cuts it only once it is on the clipboard', async () => {
    const { ed, menu } = openMenu('hello world', 'raw', new monaco.Selection(1, 1, 1, 6));
    fireEvent.click(item(menu, 'Cut'));
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith('hello');
    await act(async () => {});
    expect(ed.getValue()).toBe(' world');
    ed.dispose();
  });

  it('keeps the text when the clipboard refuses a cut', async () => {
    clipboard.copyToClipboard.mockImplementationOnce(() => Promise.reject(new Error('denied')));
    const { ed, menu } = openMenu('hello world', 'raw', new monaco.Selection(1, 1, 1, 6));
    fireEvent.click(item(menu, 'Cut'));
    await act(async () => {});
    expect(ed.getValue()).toBe('hello world');
    ed.dispose();
  });

  it('disables Cut and Copy with nothing selected, and names each shortcut outside the item name', () => {
    const { ed, menu } = openMenu('hello', 'raw');
    expect(item(menu, 'Cut')).toHaveAttribute('aria-disabled', 'true');
    expect(item(menu, 'Copy')).toHaveAttribute('aria-disabled', 'true');
    expect(item(menu, 'Find')).toHaveTextContent(/F$/);
    ed.dispose();
  });

  it('pastes over the selection, and leaves the text when the browser refuses', async () => {
    const readText = vi.fn(() => Promise.resolve('bye'));
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
    try {
      const { ed, menu } = openMenu('hello world', 'raw', new monaco.Selection(1, 1, 1, 6));
      fireEvent.click(item(menu, 'Paste'));
      await act(async () => {});
      expect(ed.getValue()).toBe('bye world');
      ed.dispose();
      cleanup();

      readText.mockImplementationOnce(() => Promise.reject(new Error('denied')));
      const again = openMenu('hello world', 'raw', new monaco.Selection(1, 1, 1, 6));
      fireEvent.click(item(again.menu, 'Paste'));
      await act(async () => {});
      expect(again.ed.getValue()).toBe('hello world');
      again.ed.dispose();
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('disables Paste where the Clipboard API is missing', () => {
    const { ed, menu } = openMenu('x', 'raw');
    expect(item(menu, 'Paste')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item(menu, 'Find'));
    ed.dispose();
  });

  it('moves the cursor to a right-click outside the selection, and keeps a selection it lands in', () => {
    const ed = monaco.editor.create(document.createElement('div'), { value: 'hello world', language: 'plaintext' });
    const at = vi.spyOn(ed, 'getTargetAtClientPoint');
    render(
      <EditorContextMenu editor={ed} file="raw">
        <div>editor body</div>
      </EditorContextMenu>,
    );
    const body = screen.getByText('editor body');
    const rightClickAt = (column: number, button = 2) => {
      at.mockReturnValue({ position: new monaco.Position(1, column) } as unknown as ReturnType<
        typeof ed.getTargetAtClientPoint
      >);
      fireEvent.pointerDown(body, { button });
    };

    ed.setSelection(new monaco.Selection(1, 1, 1, 6));
    rightClickAt(3);
    expect(ed.getSelection()?.toString()).toBe(new monaco.Selection(1, 1, 1, 6).toString());

    rightClickAt(9, 0);
    expect(ed.getSelection()?.toString()).toBe(new monaco.Selection(1, 1, 1, 6).toString());

    rightClickAt(9);
    expect(ed.getPosition()?.toString()).toBe(new monaco.Position(1, 9).toString());
    expect(ed.getSelection()?.isEmpty()).toBe(true);
    ed.dispose();
  });

  it('selects all', () => {
    const { ed, menu } = openMenu('a\nb', 'raw');
    fireEvent.click(item(menu, 'Select all'));
    expect(ed.getModel()?.getValueInRange(ed.getSelection()!)).toBe('a\nb');
    ed.dispose();
  });

  it('looks up the directive on the cursor line in the dictionary, by its base key', () => {
    const { ed, menu } = openMenu(
      '[web]\nEXTRACT-user = (?<user>\\w+)',
      'props.conf',
      new monaco.Selection(2, 3, 2, 3),
    );
    fireEvent.click(item(menu, 'Look up EXTRACT in the Dictionary'));
    expect(useAppStore.getState()).toMatchObject({ activeView: 'dictionary', dictionarySelection: 'EXTRACT' });
    ed.dispose();
  });

  it('offers no lookup on a stanza header, a comment, or the raw log', () => {
    for (const [value, file] of [
      ['[web]', 'props.conf'],
      ['# KV_MODE = json', 'props.conf'],
      ['KV_MODE = json', 'raw'],
    ] as const) {
      const { ed, menu } = openMenu(value, file);
      expect(within(menu).queryByRole('menuitem', { name: /Look up/ })).not.toBeInTheDocument();
      ed.dispose();
      cleanup();
    }
  });

  it('shares the palette and the Scaffold with the command palette', () => {
    const { ed, menu } = openMenu('x', 'raw');
    fireEvent.click(item(menu, 'Scaffold props.conf from this sample'));
    expect(useAppStore.getState().scaffoldOpen).toBe(true);
    ed.dispose();
    cleanup();
    const again = openMenu('x', 'props.conf');
    expect(within(again.menu).queryByRole('menuitem', { name: /Scaffold/ })).not.toBeInTheDocument();
    fireEvent.click(item(again.menu, 'Command palette'));
    expect(useAppStore.getState().commandPaletteOpen).toBe(true);
    again.ed.dispose();
  });
});
