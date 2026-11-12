// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { editor, languages, Position } from 'monaco-editor';
import { languages as monaco } from 'monaco-editor/editor';
import { createCompletionProvider } from '../splunkConfCompletion';
import { getDirectivesForFile } from '../../engine';
import { fakeModel } from '../../test/fakeModel';

type ConfFile = 'props.conf' | 'transforms.conf';

function completeList(
  fileType: ConfFile,
  line: string,
  column = line.length + 1,
  word: editor.IWordAtPosition | null = null,
): languages.CompletionItem[] {
  const result = createCompletionProvider(fileType).provideCompletionItems(
    fakeModel(line, { word: word ?? undefined }),
    { lineNumber: 1, column } as Position,
    {} as languages.CompletionContext,
    {} as never,
  ) as languages.CompletionList;
  return result.suggestions;
}

/** Complete at (line, column) of a multi-line text; the caret defaults to the end of the last line. */
function completeIn(
  fileType: ConfFile,
  text: string,
  lineNumber?: number,
  column?: number,
): languages.CompletionItem[] {
  const lines = text.split('\n');
  const n = lineNumber ?? lines.length;
  const result = createCompletionProvider(fileType).provideCompletionItems(
    fakeModel(text),
    { lineNumber: n, column: column ?? (lines[n - 1]?.length ?? 0) + 1 } as Position,
    {} as languages.CompletionContext,
    {} as never,
  ) as languages.CompletionList;
  return result.suggestions;
}

const labelOf = (item: languages.CompletionItem) => (typeof item.label === 'string' ? item.label : item.label.label);

// Each list is built inside its test, not in the describe body: Stryker turns a
// mutant on for the run, after the file is collected, so a list built at
// collection would always be the unmutated one (#816).
describe.each<ConfFile>(['props.conf', 'transforms.conf'])('directive completion in %s', (fileType) => {
  let items: languages.CompletionItem[] = [];
  let labels: string[] = [];
  const directives = getDirectivesForFile(fileType);
  beforeEach(() => {
    items = completeList(fileType, '');
    labels = items.map(labelOf);
  });

  // Unsimulated directives carry an object label, and are still listed once.
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
  let items: languages.CompletionItem[] = [];
  beforeEach(() => {
    items = completeList('props.conf', '');
  });

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
  it('suggests every props.conf stanza prefix inside a bracket', () => {
    expect(completeList('props.conf', '[').map(labelOf)).toEqual([
      'default',
      'source::',
      'host::',
      'rule::',
      'delayedrule::',
    ]);
  });

  it('suggests only what transforms.conf can name: no source:: or host::', () => {
    expect(completeList('transforms.conf', '[').map(labelOf)).toEqual(['default']);
  });

  it('inserts a placeholder after each prefix', () => {
    const insert = Object.fromEntries(completeList('props.conf', '[').map((i) => [labelOf(i), i.insertText]));
    expect(insert['rule::']).toBe('rule::${1:rulename}]');
    expect(insert['delayedrule::']).toBe('delayedrule::${1:rulename}]');
    expect(insert['source::']).toBe('source::${1:path}]');
  });

  it('suggests nothing once the header is closed', () => {
    expect(completeList('props.conf', '[st]')).toEqual([]);
    expect(completeList('props.conf', '[st] x', 7)).toEqual([]);
  });

  it('still completes a bracket that is not closed yet, caret before a later ]', () => {
    expect(completeList('props.conf', '[so]', 4).map(labelOf)).toContain('source::');
  });
});

describe('where completion stays quiet (#501)', () => {
  it.each(['# ', '# TRUNC', '#', '  # note'])('offers nothing on the comment line %j', (line) => {
    expect(completeList('props.conf', line)).toEqual([]);
  });

  it('offers nothing on the line after a trailing backslash', () => {
    expect(completeIn('props.conf', 'EXTRACT-a = (?<x>\\d+)\\\n')).toEqual([]);
    expect(completeIn('props.conf', 'EXTRACT-a = (?<x>\\d+)\\\nTRUN')).toEqual([]);
  });

  it('but an even run of backslashes is escaped text, not a continuation', () => {
    expect(completeIn('props.conf', 'X = C:\\\\\nTRUN').length).toBeGreaterThan(0);
  });

  it('completes the key after a continuation has ended', () => {
    expect(completeIn('props.conf', 'X = a\\\nb\nTRUN').length).toBeGreaterThan(0);
  });
});

describe('key completion with a value already on the line (#501)', () => {
  it('inserts the bare key when the caret is before the =', () => {
    const items = completeList('props.conf', 'TRUNC = 5000', 6);
    expect(items.find((i) => labelOf(i) === 'TRUNCATE')?.insertText).toBe('TRUNCATE');
    expect(items.find((i) => labelOf(i) === 'EXTRACT')?.insertText).toBe('EXTRACT-${1:classname}');
  });

  it('inserts the bare key with the caret right at the =', () => {
    const line = 'TRUNC= 5000';
    const items = completeList('props.conf', line, line.indexOf('=') + 1);
    expect(items.find((i) => labelOf(i) === 'TRUNCATE')?.insertText).toBe('TRUNCATE');
  });

  it('still inserts `KEY = default` on a line with no value', () => {
    const items = completeList('props.conf', 'TRUNC');
    expect(items.find((i) => labelOf(i) === 'TRUNCATE')?.insertText).toMatch(/^TRUNCATE = \$\{1:/);
  });
});

describe('snippet defaults are escaped (#501)', () => {
  it('escapes backslash, dollar and closing brace in every plain directive default', () => {
    const items = completeList('props.conf', '');
    const escaped = getDirectivesForFile('props.conf').filter((d) => !d.isClassBased && /[\\$}]/.test(d.defaultValue));
    expect(escaped.length).toBeGreaterThan(0);
    for (const dir of escaped) {
      const item = items.find((i) => labelOf(i) === dir.key)!;
      const body = /^[^=]+= \$\{1:([\s\S]*)\}$/.exec(item.insertText)![1]!;
      // No bare special character survives: every one is preceded by a backslash.
      expect(body.replace(/\\[\\$}]/g, '')).not.toMatch(/[\\$}]/);
      // And unescaping gives the default back.
      expect(body.replace(/\\([\\$}])/g, '$1')).toBe(dir.defaultValue);
    }
  });
});

describe("completion item kinds are the editor API's own (#499)", () => {
  const kindOf = (items: languages.CompletionItem[], label: string) => items.find((i) => labelOf(i) === label)?.kind;

  it('reads the enum from the runtime, whose numbers differ from the ones once hard-coded', () => {
    expect(monaco.CompletionItemKind.Enum).toBe(15);
    expect(monaco.CompletionItemKind.Value).toBe(13);
    expect(monaco.CompletionItemKind.Snippet).toBe(28);
    expect(monaco.CompletionItemKind.Constant).toBe(14);
  });

  it('marks a directive key a Property', () => {
    expect(kindOf(completeList('props.conf', ''), 'TRUNCATE')).toBe(monaco.CompletionItemKind.Property);
  });

  it('marks a class-based directive pattern a Snippet', () => {
    expect(kindOf(completeList('props.conf', ''), 'EXTRACT-')).toBe(monaco.CompletionItemKind.Snippet);
    expect(kindOf(completeList('props.conf', ''), 'EXTRACT')).toBe(monaco.CompletionItemKind.Snippet);
  });

  it('marks stanza prefixes an Enum', () => {
    for (const item of completeList('props.conf', '[')) expect(item.kind).toBe(monaco.CompletionItemKind.Enum);
  });

  it('marks boolean and enum values a Value', () => {
    const bool = getDirectivesForFile('props.conf').find((d) => d.valueType === 'boolean')!;
    for (const item of completeList('props.conf', `${bool.key} = `))
      expect(item.kind).toBe(monaco.CompletionItemKind.Value);
    const en = getDirectivesForFile('props.conf').find((d) => d.valueType === 'enum' && d.enumValues?.length)!;
    for (const item of completeList('props.conf', `${en.key} = `))
      expect(item.kind).toBe(monaco.CompletionItemKind.Value);
  });

  it('marks strftime tokens a Constant', () => {
    for (const item of completeList('props.conf', 'TIME_FORMAT = ')) {
      expect(item.kind).toBe(monaco.CompletionItemKind.Constant);
    }
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

describe('the completion provider', () => {
  it('triggers on "=", "[" and a new line', () => {
    expect(createCompletionProvider('props.conf').triggerCharacters).toEqual(['=', '[', '\n']);
  });

  it('lists the stanza prefixes with their details and snippets', () => {
    expect(completeList('props.conf', '[').map((i) => [labelOf(i), i.detail, i.insertText])).toEqual([
      ['default', 'Default stanza - applies to all sourcetypes', 'default]'],
      ['source::', 'Source-based stanza (highest precedence)', 'source::${1:path}]'],
      ['host::', 'Host-based stanza', 'host::${1:hostname}]'],
      ['rule::', 'Rule-based sourcetype classification', 'rule::${1:rulename}]'],
      ['delayedrule::', 'Delayed rule-based sourcetype classification (checked last)', 'delayedrule::${1:rulename}]'],
    ]);
  });
});

describe('a line that starts with "="', () => {
  it('completes the bare key when the caret is before the "="', () => {
    const kv = completeList('props.conf', '= json', 1).find((i) => labelOf(i) === 'KV_MODE');
    expect(kv?.insertText).toBe('KV_MODE');
  });

  it('suggests no value after it, because there is no key', () => {
    expect(completeList('props.conf', '= json', 2)).toEqual([]);
  });
});

describe('a directive suggestion', () => {
  let items: languages.CompletionItem[] = [];
  beforeEach(() => {
    items = completeList('props.conf', '');
  });
  const byLabel = (label: string) => items.find((i) => labelOf(i) === label)!;
  const category = (key: string) => getDirectivesForFile('props.conf').find((d) => d.key === key)!.category;

  it('describes a simulated directive in full', () => {
    const kv = getDirectivesForFile('props.conf').find((d) => d.key === 'KV_MODE')!;
    expect(byLabel('KV_MODE')).toMatchObject({
      label: 'KV_MODE',
      kind: monaco.CompletionItemKind.Property,
      detail: `${kv.category} (${kv.phase})`,
      documentation: {
        value: [
          '**KV_MODE**',
          '',
          kv.description,
          '',
          `**Default:** \`auto\` &nbsp; **Phase:** ${kv.phase} &nbsp; **Type:** ${kv.valueType}`,
          '',
          '**Example:**',
          '```',
          kv.example,
          '```',
        ].join('\n'),
      },
      insertText: 'KV_MODE = ${1:auto}',
      insertTextRules: monaco.CompletionItemInsertTextRule.InsertAsSnippet,
    });
  });

  it('says "out of scope" for a documented directive, in the label, the detail and the documentation', () => {
    const dir = getDirectivesForFile('props.conf').find((d) => d.key === 'LINE_BREAKER_LOOKBEHIND')!;
    const item = byLabel('LINE_BREAKER_LOOKBEHIND');
    expect(item.label).toEqual({ label: 'LINE_BREAKER_LOOKBEHIND', description: 'out of scope' });
    expect(item.detail).toBe(`${dir.category} (${dir.phase}) — out of scope`);
    expect((item.documentation as { value: string }).value.split('\n').slice(0, 5)).toEqual([
      '**LINE_BREAKER_LOOKBEHIND**',
      '',
      `> ℹ️ **Outside the simulation.** ${dir.supportNote}`,
      '',
      dir.description,
    ]);
  });

  it('writes (none) for an empty default, and inserts a value placeholder', () => {
    const item = byLabel('TIME_PREFIX');
    expect((item.documentation as { value: string }).value).toContain('**Default:** `(none)` &nbsp;');
    expect(item.insertText).toBe('TIME_PREFIX = ${1:value}');
  });

  it('pairs each class-based directive with its pattern snippet, next in order', () => {
    const index = items.findIndex((i) => labelOf(i) === 'EXTRACT');
    const [main, snippet] = [items[index]!, items[index + 1]!];
    expect(main.kind).toBe(monaco.CompletionItemKind.Snippet);
    expect(snippet).toMatchObject({
      label: 'EXTRACT-',
      kind: monaco.CompletionItemKind.Snippet,
      detail: `EXTRACT-<class> (${category('EXTRACT')})`,
      insertText: 'EXTRACT-${1:classname} = ${2:value}',
      insertTextRules: monaco.CompletionItemInsertTextRule.InsertAsSnippet,
    });
    expect(Number(snippet.sortText)).toBe(Number(main.sortText) + 1);
    expect(items.some((i) => labelOf(i) === 'KV_MODE-')).toBe(false);
  });

  it('numbers the sort keys from 0000', () => {
    expect(items[0]?.sortText).toBe('0000');
  });

  it('inserts the bare key as plain text with a value already on the line, and a class key still as a snippet', () => {
    const withValue = completeList('props.conf', 'X = 1', 1);
    const kv = withValue.find((i) => labelOf(i) === 'KV_MODE')!;
    expect(kv.insertText).toBe('KV_MODE');
    expect(kv).not.toHaveProperty('insertTextRules');
    const extract = withValue.find((i) => labelOf(i) === 'EXTRACT')!;
    expect(extract.insertText).toBe('EXTRACT-${1:classname}');
    expect(extract.insertTextRules).toBe(monaco.CompletionItemInsertTextRule.InsertAsSnippet);
    expect(withValue.find((i) => labelOf(i) === 'EXTRACT-')?.insertText).toBe('EXTRACT-${1:classname}');
  });
});

describe('value suggestions, in detail', () => {
  it('labels and describes true and false', () => {
    const dir = getDirectivesForFile('props.conf').find((d) => d.valueType === 'boolean')!;
    expect(completeList('props.conf', `${dir.key} = `).map((i) => [i.insertText, i.detail])).toEqual([
      ['true', 'Boolean true'],
      ['false', 'Boolean false'],
    ]);
  });

  it('names the directive in each enumerated value', () => {
    expect(completeList('props.conf', 'KV_MODE = ').every((i) => i.detail === 'Valid value for KV_MODE')).toBe(true);
  });

  it('offers five named strftime formats, each with its rendering', () => {
    const items = completeList('props.conf', 'TIME_FORMAT = ');
    expect(items.map((i) => [i.insertText, i.detail])).toEqual([
      ['%Y-%m-%dT%H:%M:%S', 'ISO 8601 datetime'],
      ['%Y-%m-%d %H:%M:%S', 'Standard datetime'],
      ['%b %d %H:%M:%S', 'Syslog format'],
      ['%s', 'Epoch seconds'],
      ['%Y-%m-%dT%H:%M:%S.%3N%z', 'ISO 8601 with milliseconds and timezone'],
    ]);
    expect(items.every((i) => (i.documentation as { value: string }).value.startsWith('**Now:**'))).toBe(true);
  });

  it('replaces only the word when no "%" is before it', () => {
    const [first] = completeList('props.conf', 'KV_MODE = js', 13, { word: 'js', startColumn: 11, endColumn: 13 });
    expect(first?.range).toEqual({ startLineNumber: 1, startColumn: 11, endLineNumber: 1, endColumn: 13 });
  });

  it('inserts at the caret when it is on no word', () => {
    const [first] = completeList('props.conf', 'KV_MODE = ', 11);
    expect(first?.range).toEqual({ startLineNumber: 1, startColumn: 11, endLineNumber: 1, endColumn: 11 });
  });
});
