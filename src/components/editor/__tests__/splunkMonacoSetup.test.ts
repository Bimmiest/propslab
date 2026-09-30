// ---------------------------------------------------------------------------
// splunkMonacoSetup.test.ts
// Registration of the conf languages: idempotent, undoable (dev HMR
// re-evaluates the module and must not stack a second set of providers), and
// retried rather than left half-done when it throws part-way.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';

const monaco = vi.hoisted(() => {
  const disposables: { name: string; disposed: boolean }[] = [];
  const track = (name: string) => () => {
    const entry = { name, disposed: false };
    disposables.push(entry);
    return {
      dispose: () => {
        entry.disposed = true;
      },
    };
  };
  return {
    disposables,
    register: vi.fn(),
    registerCommand: vi.fn(track('command')),
    setMonarchTokensProvider: vi.fn(track('tokens')),
    registerFoldingRangeProvider: vi.fn(track('folding')),
    registerCompletionItemProvider: vi.fn(track('completion')),
    registerHoverProvider: vi.fn(track('hover')),
    registerCodeActionProvider: vi.fn(track('codeAction')),
    defineTheme: vi.fn(),
  };
});

vi.mock('monaco-editor/editor', () => ({
  editor: { registerCommand: monaco.registerCommand, defineTheme: monaco.defineTheme },
  languages: {
    register: monaco.register,
    setMonarchTokensProvider: monaco.setMonarchTokensProvider,
    registerFoldingRangeProvider: monaco.registerFoldingRangeProvider,
    registerCompletionItemProvider: monaco.registerCompletionItemProvider,
    registerHoverProvider: monaco.registerHoverProvider,
    registerCodeActionProvider: monaco.registerCodeActionProvider,
    CompletionItemKind: { Enum: 15, Value: 13, Snippet: 28, Constant: 14, Property: 9 },
    FoldingRangeKind: { Region: { value: 'region' }, Comment: { value: 'comment' } },
  },
}));

import { ensureSplunkMonaco, disposeSplunkMonaco } from '../splunkMonacoSetup';

const live = () => monaco.disposables.filter((d) => !d.disposed).length;

beforeEach(() => {
  disposeSplunkMonaco();
  monaco.disposables.length = 0;
  for (const value of Object.values(monaco)) if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
  monaco.registerHoverProvider.mockImplementation(() => {
    const entry = { name: 'hover', disposed: false };
    monaco.disposables.push(entry);
    return {
      dispose: () => {
        entry.disposed = true;
      },
    };
  });
});

describe('ensureSplunkMonaco', () => {
  it('registers every provider once, however often it is called', () => {
    ensureSplunkMonaco();
    ensureSplunkMonaco();
    expect(monaco.registerHoverProvider).toHaveBeenCalledTimes(2); // props and transforms
    expect(monaco.registerCompletionItemProvider).toHaveBeenCalledTimes(2);
    expect(monaco.registerFoldingRangeProvider).toHaveBeenCalledTimes(2);
    expect(monaco.registerCodeActionProvider).toHaveBeenCalledTimes(2);
    expect(monaco.setMonarchTokensProvider).toHaveBeenCalledTimes(2);
    expect(monaco.registerCommand).toHaveBeenCalledTimes(1);
    expect(monaco.defineTheme).toHaveBeenCalledTimes(2);
  });

  it('keeps every disposable, so disposing takes the whole set down', () => {
    ensureSplunkMonaco();
    expect(live()).toBe(11);
    disposeSplunkMonaco();
    expect(live()).toBe(0);
  });

  it('registers a fresh set after a dispose, as a hot-reloaded module does, without doubling up', () => {
    ensureSplunkMonaco();
    disposeSplunkMonaco();
    ensureSplunkMonaco();
    expect(monaco.registerHoverProvider).toHaveBeenCalledTimes(4);
    expect(live()).toBe(11);
  });

  it('is safe to dispose when nothing is registered', () => {
    expect(() => disposeSplunkMonaco()).not.toThrow();
  });

  it('retries after a failure part-way, undoing the half it had registered', () => {
    monaco.registerHoverProvider.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => ensureSplunkMonaco()).toThrow('boom');
    // The command, tokenizers, folding and completion had been registered: all undone.
    expect(live()).toBe(0);

    ensureSplunkMonaco();
    expect(live()).toBe(11);
    ensureSplunkMonaco();
    expect(live()).toBe(11);
  });
});
