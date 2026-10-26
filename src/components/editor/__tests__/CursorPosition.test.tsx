// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// CursorPosition.test.tsx
// The cursor footer under each editor (#740): line, column in characters,
// byte column for the raw log, and the selection's length, read from a REAL
// Monaco editor (see src/test/monacoJsdom.ts).
// ---------------------------------------------------------------------------

import '../../../test/monacoJsdom';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import * as monaco from 'monaco-editor/editor';
import { cursorStats, formatCursorStats } from '../cursorStats';

const { CursorPosition } = await import('../CursorPosition');

afterEach(() => {
  cleanup();
  for (const model of monaco.editor.getModels()) model.dispose();
});

function editorWith(value: string) {
  return monaco.editor.create(document.createElement('div'), { value, language: 'plaintext' });
}

describe('cursorStats', () => {
  it('counts the column in characters and the byte column in UTF-8, both from 1', () => {
    expect(cursorStats(1, '', '')).toEqual({ line: 1, col: 1, byte: 1, chars: 0, bytes: 0 });
    // é is one character and two bytes; 😀 is one character, two UTF-16 units and four bytes.
    expect(cursorStats(3, 'é😀a', '')).toMatchObject({ line: 3, col: 4, byte: 8 });
  });

  it('counts the selection the same way, newlines included', () => {
    expect(cursorStats(1, '', 'ab\nc😀')).toMatchObject({ chars: 5, bytes: 8 });
  });
});

describe('formatCursorStats', () => {
  const at = cursorStats(12, 'x'.repeat(33), '');
  const selecting = cursorStats(12, 'x'.repeat(33), 'éééé');

  it('shows bytes only where they are asked for', () => {
    expect(formatCursorStats(at, false)).toBe('Ln 12, Col 34');
    expect(formatCursorStats(at, true)).toBe('Ln 12, Col 34, Byte 34');
  });

  it('adds the selection when there is one', () => {
    expect(formatCursorStats(selecting, false)).toBe('Ln 12, Col 34 · 4 selected');
    expect(formatCursorStats(selecting, true)).toBe('Ln 12, Col 34, Byte 34 · 4 selected (8 bytes)');
  });
});

describe('CursorPosition', () => {
  it('shows nothing before the editor exists', () => {
    const { container } = render(<CursorPosition editor={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('follows the cursor and the selection', () => {
    const ed = editorWith('first line\n2026-01-02 éa');
    render(<CursorPosition editor={ed} withBytes />);
    expect(screen.getByText('Ln 1, Col 1, Byte 1')).toBeInTheDocument();

    act(() => ed.setPosition({ lineNumber: 2, column: 13 }));
    expect(screen.getByText('Ln 2, Col 13, Byte 14')).toBeInTheDocument();

    // Dragged backwards: the cursor is at the start of the selection.
    act(() => ed.setSelection(new monaco.Selection(2, 13, 2, 1)));
    expect(screen.getByText('Ln 2, Col 1, Byte 1 · 12 selected (13 bytes)')).toBeInTheDocument();
    ed.dispose();
  });

  it('updates when an edit before the cursor changes its byte column but not its column', () => {
    const ed = editorWith('abc');
    ed.setPosition({ lineNumber: 1, column: 4 });
    render(<CursorPosition editor={ed} withBytes />);
    expect(screen.getByText('Ln 1, Col 4, Byte 4')).toBeInTheDocument();
    act(() => ed.getModel()?.applyEdits([{ range: new monaco.Range(1, 1, 1, 2), text: 'é' }]));
    expect(screen.getByText('Ln 1, Col 4, Byte 5')).toBeInTheDocument();
    ed.dispose();
  });
});
