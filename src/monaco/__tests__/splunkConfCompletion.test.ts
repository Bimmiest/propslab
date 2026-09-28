import { describe, it, expect } from 'vitest';
import type { editor, languages, Position } from 'monaco-editor';
import { createCompletionProvider } from '../splunkConfCompletion';
import { getDirectivesForFile } from '../../engine/directiveRegistry';

type ConfFile = 'props.conf' | 'transforms.conf';

function fakeModel(text: string, word: editor.IWordAtPosition | null = null): editor.ITextModel {
  const lines = text.split('\n');
  return {
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getValue: () => text,
    getWordAtPosition: () => word,
  } as unknown as editor.ITextModel;
}

function completeList(
  fileType: ConfFile,
  line: string,
  column = line.length + 1,
  word: editor.IWordAtPosition | null = null,
): languages.CompletionItem[] {
  const result = createCompletionProvider(fileType).provideCompletionItems(
    fakeModel(line, word),
    { lineNumber: 1, column } as Position,
    {} as languages.CompletionContext,
    {} as never,
  ) as languages.CompletionList;
  return result.suggestions;
}

const labelOf = (item: languages.CompletionItem) =>
  typeof item.label === 'string' ? item.label : item.label.label;

describe.each<ConfFile>(['props.conf', 'transforms.conf'])('directive completion in %s', (fileType) => {
  const items = completeList(fileType, '');
  const labels = items.map(labelOf);
  const directives = getDirectivesForFile(fileType);

  // Unsimulated directives carry an object label; the "uncategorised" pass
  // must still recognise them as already listed.
  it('lists every label once', () => {
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect(dupes).toEqual([]);
  });

  it('offers exactly the directives valid in the file, plus a snippet per class-based one', () => {
    const keys = directives.map((d) => d.key);
    const classSnippets = directives.filter((d) => d.isClassBased).map((d) => `${d.key}-`);
    expect(new Set(labels)).toEqual(new Set([...keys, ...classSnippets]));
    expect(labels).toHaveLength(keys.length + classSnippets.length);
  });

  it('marks unsimulated directives in the label, and only those', () => {
    for (const dir of directives) {
      const item = items.find((i) => labelOf(i) === dir.key)!;
      expect(typeof item.label === 'string').toBe(dir.support === 'simulated');
    }
  });

  it('gives each suggestion a distinct sort key, in list order', () => {
    const sortTexts = items.map((i) => i.sortText!);
    expect(new Set(sortTexts).size).toBe(items.length);
    expect([...sortTexts].sort()).toEqual(sortTexts);
  });
});

describe('directive completion — insert text', () => {
  const items = completeList('props.conf', '');

  it('inserts a class placeholder for a class-based directive', () => {
    const extract = items.find((i) => labelOf(i) === 'EXTRACT')!;
    expect(extract.insertText).toBe('EXTRACT-${1:classname} = ${2:value}');
  });

  it('inserts `KEY = default` for a plain directive', () => {
    const dir = getDirectivesForFile('props.conf').find((d) => !d.isClassBased && d.defaultValue)!;
    const item = items.find((i) => labelOf(i) === dir.key)!;
    expect(item.insertText).toBe(`${dir.key} = \${1:${dir.defaultValue}}`);
  });
});

describe('stanza completion', () => {
  it('suggests stanza types inside a bracket', () => {
    expect(completeList('props.conf', '[').map(labelOf)).toEqual(['default', 'source::', 'host::']);
  });
});

describe('value completion', () => {
  it('suggests true/false for a boolean directive', () => {
    const dir = getDirectivesForFile('props.conf').find((d) => d.valueType === 'boolean')!;
    expect(completeList('props.conf', `${dir.key} = `).map(labelOf)).toEqual(['true', 'false']);
  });

  it('suggests the enumerated values', () => {
    const dir = getDirectivesForFile('props.conf').find((d) => d.valueType === 'enum' && d.enumValues?.length)!;
    expect(completeList('props.conf', `${dir.key} = `).map(labelOf)).toEqual(dir.enumValues);
  });

  it('suggests strftime tokens for TIME_FORMAT, each with a rendered preview', () => {
    const items = completeList('props.conf', 'TIME_FORMAT = ');
    expect(items.map(labelOf)).toContain('%Y-%m-%dT%H:%M:%S');
    expect(items.every((i) => i.documentation)).toBe(true);
  });

  it('suggests nothing for an unknown key', () => {
    expect(completeList('props.conf', 'NOT_A_DIRECTIVE = ')).toEqual([]);
  });

  it('replaces a `%` just before the word too', () => {
    const line = 'TIME_FORMAT = %Y';
    const [first] = completeList('props.conf', line, 17, { word: 'Y', startColumn: 16, endColumn: 17 });
    expect(first?.range).toMatchObject({ startColumn: 15, endColumn: 17 });
  });
});
