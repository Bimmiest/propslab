// @vitest-environment jsdom
// No directive is `ignored` today, so this file gives the completion list two
// invented ones, to hold how it marks a directive the preview does not simulate.
import { describe, it, expect, vi } from 'vitest';
import type { languages, Position } from 'monaco-editor';
import { createCompletionProvider } from '../splunkConfCompletion';
import { fakeModel } from '../../test/fakeModel';

vi.mock('propslab-engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('propslab-engine')>();
  const base = original.getDirectivesForFile('props.conf').find((d) => d.key === 'KV_MODE')!;
  const synthetic = [
    {
      ...base,
      key: 'ZZ_IGNORED_TRACKED',
      support: 'ignored' as const,
      supportNote: 'The preview skips it.',
      supportIssue: 42,
    },
    { ...base, key: 'ZZ_IGNORED_BARE', support: 'ignored' as const, supportNote: undefined, supportIssue: undefined },
  ];
  return {
    ...original,
    getDirectivesForFile: () => synthetic,
    getDirectivesByCategory: () => new Map([['Synthetic', synthetic]]),
  };
});

function suggestions(): languages.CompletionItem[] {
  const result = createCompletionProvider('props.conf').provideCompletionItems(
    fakeModel(''),
    { lineNumber: 1, column: 1 } as Position,
    {} as languages.CompletionContext,
    {} as never,
  ) as languages.CompletionList;
  return result.suggestions;
}

describe('a directive that the preview does not simulate', () => {
  it('says "not simulated" in the label and the detail', () => {
    const [tracked] = suggestions();
    expect(tracked?.label).toEqual({ label: 'ZZ_IGNORED_TRACKED', description: 'not simulated' });
    expect(tracked?.detail).toMatch(/^Synthetic \(.+\) — not simulated$/);
  });

  it('warns in the documentation, with its note and the issue that tracks it', () => {
    const [tracked, bare] = suggestions();
    expect((tracked?.documentation as { value: string }).value.split('\n')[2]).toBe(
      '> ⚠️ **Not simulated.** The preview skips it. Tracked as #42.',
    );
    const line = (bare?.documentation as { value: string }).value.split('\n')[2];
    expect(line?.startsWith('> ⚠️ **Not simulated.**')).toBe(true);
    expect(line).not.toContain('Tracked');
  });
});
