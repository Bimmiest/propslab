import { describe, it, expect } from 'vitest';
import { marked, type Tokens } from 'marked';
import { createHoverProvider } from '../splunkConfHover';
import { OPEN_DICTIONARY_COMMAND_ID, openDictionaryCommandUri } from '../dictionaryCommand';
import type { editor, Position, languages } from 'monaco-editor';

function fakeModel(text: string): editor.ITextModel {
  const lines = text.split('\n');
  return {
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getValue: () => text,
    getWordAtPosition: () => null,
  } as unknown as editor.ITextModel;
}

const at = (lineNumber: number, column: number) => ({ lineNumber, column }) as Position;

function hoverText(line: string): string {
  const provider = createHoverProvider('props.conf');
  const result = provider.provideHover(
    fakeModel(line),
    at(1, 2),
    {} as never,
    undefined,
  ) as languages.Hover | null | undefined;
  return result?.contents?.map((c) => c.value).join('\n') ?? '';
}

// #31.1: hover matched `/^\[(.+)\]$/` against the RAW line, so `[foo] ` (with a
// trailing space) got no hover at all — stricter than confParser's STANZA_RE,
// which tolerates surrounding whitespace.
describe('splunkConfHover — stanza headers with surrounding whitespace (#31.1)', () => {
  it('hovers a stanza header with a trailing space', () => {
    expect(hoverText('[my:sourcetype] ')).not.toBe('');
  });

  it('hovers a stanza header with a leading space', () => {
    expect(hoverText('  [source::/var/log/app.log]')).not.toBe('');
  });

  it('still hovers a plain stanza header', () => {
    expect(hoverText('[my:sourcetype]')).not.toBe('');
  });
});

// #296: the directive hover is trusted (so its "Open in dictionary" command link
// works) and its heading is the key AS TYPED. A key such as
// `EXTRACT-x](command:foo)[` closed nothing and opened a link of its own, which
// trusted Markdown would run as a command.
describe('splunkConfHover — document text cannot inject Markdown (#296)', () => {
  function hover(line: string, fileType: 'props.conf' | 'transforms.conf' = 'props.conf') {
    const result = createHoverProvider(fileType).provideHover(
      fakeModel(line),
      at(1, 2),
      {} as never,
      undefined,
    ) as languages.Hover | null | undefined;
    return result?.contents ?? [];
  }

  /** Every link target in the rendered hover, as Monaco's marked would parse it. */
  function linkHrefs(markdown: string): string[] {
    const hrefs: string[] = [];
    void marked.walkTokens(marked.lexer(markdown), (t) => {
      if (t.type === 'link' || t.type === 'image') hrefs.push((t as Tokens.Link).href);
    });
    return hrefs;
  }

  const expectedLink = openDictionaryCommandUri('EXTRACT');

  it.each([
    // Unescaped, this one renders a working `command:foo` link in the heading.
    'EXTRACT-[x](command:foo) = (?<a>.)',
    'EXTRACT-x](command:foo)[ = (?<a>.)',
    'EXTRACT-x](command:workbench.action.terminal.new)[ = (?<a>.)',
    'EXTRACT-![i](https://example.invalid/x.png) = (?<a>.)',
    'EXTRACT-`](command:foo)` = (?<a>.)',
    'EXTRACT-https://example.invalid = (?<a>.)',
  ])('links only to the dictionary for %s', (line) => {
    const [content] = hover(line);
    expect(content).toBeDefined();
    expect(linkHrefs(content!.value)).toEqual([expectedLink]);
  });

  it('still shows the key and class name as typed', () => {
    const [content] = hover('EXTRACT-x](command:foo)[ = (?<a>.)');
    const html = marked.parse(content!.value, { async: false });
    expect(html).toContain('EXTRACT-x](command:foo)[');
    expect(html).toContain('EXTRACT-&lt;x](command:foo)[&gt;');
  });

  it('trusts only the dictionary command, not every command', () => {
    const [content] = hover('EXTRACT-ip = (?<ip>\\S+)');
    expect(content!.isTrusted).toEqual({ enabledCommands: [OPEN_DICTIONARY_COMMAND_ID] });
    expect(linkHrefs(content!.value)).toEqual([expectedLink]);
  });

  it('escapes a stanza name, which reaches the (untrusted) stanza hover too', () => {
    for (const line of ['[x](command:foo)[y]','[source::`](https://example.invalid)`]', '[host::![i](https://example.invalid)]']) {
      const [content] = hover(line);
      expect(content).toBeDefined();
      expect(content!.isTrusted).toBeFalsy();
      expect(linkHrefs(content!.value)).toEqual([]);
    }
  });
});
