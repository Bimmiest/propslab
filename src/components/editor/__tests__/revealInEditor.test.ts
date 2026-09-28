// @vitest-environment jsdom
// A jump-to-line link has to work when its editor is not mounted: a collapsed
// panel, or the mobile layout showing Output (#432).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { editor } from 'monaco-editor';
import { revealInEditor } from '../revealInEditor';
import { registerEditor, unregisterEditor } from '../editorRegistry';
import { useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();

function fakeEditor() {
  return {
    focus: vi.fn(),
    setPosition: vi.fn(),
    revealLineInCenter: vi.fn(),
  };
}
type Fake = ReturnType<typeof fakeEditor>;
const asEditor = (f: Fake) => f as unknown as editor.IStandaloneCodeEditor;

describe('revealInEditor', () => {
  const registered: [string, Fake][] = [];
  const register = (file: string, f: Fake) => {
    registered.push([file, f]);
    registerEditor(file, asEditor(f));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(initial, true);
  });

  afterEach(() => {
    for (const [file, f] of registered.splice(0)) unregisterEditor(file, asEditor(f));
    vi.useRealTimers();
  });

  const expectRevealed = (f: Fake, line: number) => {
    expect(f.focus).toHaveBeenCalled();
    vi.advanceTimersByTime(50); // the requestAnimationFrame
    expect(f.setPosition).toHaveBeenCalledWith({ lineNumber: line, column: 1 });
    expect(f.revealLineInCenter).toHaveBeenCalledWith(line);
  };

  it('reveals the line in an editor that is already mounted', () => {
    const ed = fakeEditor();
    register('props.conf', ed);
    revealInEditor('props.conf', 7);
    expectRevealed(ed, 7);
  });

  it('expands a collapsed panel and reveals once its editor mounts', () => {
    useAppStore.setState({ collapsedPanels: { 'props.conf': true, 'transforms.conf': true } });
    revealInEditor('props.conf', 3);
    expect(useAppStore.getState().collapsedPanels).toEqual({ 'props.conf': false, 'transforms.conf': true });

    const ed = fakeEditor();
    register('props.conf', ed);
    expectRevealed(ed, 3);
  });

  it('switches the mobile layout, and the dictionary, back to the editor', () => {
    useAppStore.setState({ activeView: 'dictionary', mobileView: 'output' });
    revealInEditor('transforms.conf', 12);
    expect(useAppStore.getState().activeView).toBe('simulator');
    expect(useAppStore.getState().mobileView).toBe('transforms');

    const ed = fakeEditor();
    register('transforms.conf', ed);
    expectRevealed(ed, 12);
  });

  it('waits only for the file it was asked for', () => {
    revealInEditor('props.conf', 4);
    const other = fakeEditor();
    register('transforms.conf', other);
    expect(other.focus).not.toHaveBeenCalled();
  });

  it('drops the jump when the editor never mounts', () => {
    revealInEditor('props.conf', 5);
    vi.advanceTimersByTime(10_001);
    const ed = fakeEditor();
    register('props.conf', ed);
    expect(ed.focus).not.toHaveBeenCalled();
  });

  it('follows only the latest jump', () => {
    revealInEditor('props.conf', 1);
    revealInEditor('props.conf', 9);
    const ed = fakeEditor();
    register('props.conf', ed);
    expect(ed.focus).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(ed.setPosition).toHaveBeenCalledTimes(1);
    expect(ed.setPosition).toHaveBeenCalledWith({ lineNumber: 9, column: 1 });
  });
});
