import { describe, it, expect, vi } from 'vitest';
import { marked, type Tokens } from 'marked';
import type { Position, languages } from 'monaco-editor';
import { createHoverProvider } from '../splunkConfHover';
import { OPEN_DICTIONARY_COMMAND_ID, openDictionaryCommandUri } from '../dictionaryCommand';
import { escapeMarkdown, inlineCode } from '../markdown';
import { fakeModel } from '../../test/fakeModel';
import { getDirectiveInfo, type DirectiveInfo } from '../../engine/directiveRegistry';
import { classifyStanza } from '../../engine/stanzaRegistry';
import { getStagesForDirective } from '../../engine/pipelineStages';

/**
 * No directive is `ignored` today, so the hover's "Not simulated" branch is fed
 * through two invented keys. Every other key reaches the real registry.
 */
const SYNTHETIC: Record<string, Partial<DirectiveInfo>> = {
  ZZ_IGNORED_TRACKED: { support: 'ignored', supportNote: 'The preview skips it.', supportIssue: 42 },
  ZZ_IGNORED_BARE: { support: 'ignored' },
  ZZ_DOCUMENTED_BARE: { support: 'documented' },
};
vi.mock('../../engine/directiveRegistry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../engine/directiveRegistry')>();
  return {
    ...original,
    getDirectiveInfo: (key: string, file: 'props.conf' | 'transforms.conf') => {
      const synthetic = SYNTHETIC[key];
      const base = original.getDirectiveInfo('KV_MODE', file);
      if (synthetic && base) return { ...base, key, supportNote: undefined, supportIssue: undefined, ...synthetic };
      return original.getDirectiveInfo(key, file);
    },
  };
});

const at = (lineNumber: number, column: number) => ({ lineNumber, column }) as Position;

function hoverText(line: string): string {
  const provider = createHoverProvider('props.conf');
  const result = provider.provideHover(fakeModel(line), at(1, 2), {} as never, undefined) as
    languages.Hover | null | undefined;
  return result?.contents.map((c) => c.value).join('\n') ?? '';
}

// A stanza header with a trailing space (`[foo] `) gets a hover, as confParser's
// STANZA_RE tolerates surrounding whitespace.
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

// The directive hover is trusted (so its "Open in dictionary" command link
// works) and its heading is the key AS TYPED, so a key such as
// `EXTRACT-x](command:foo)[` must be escaped, or trusted Markdown would run the
// link it opens as a command.
describe('splunkConfHover — document text cannot inject Markdown (#296)', () => {
  function hover(line: string, fileType: 'props.conf' | 'transforms.conf' = 'props.conf') {
    const result = createHoverProvider(fileType).provideHover(fakeModel(line), at(1, 2), {} as never, undefined) as
      languages.Hover | null | undefined;
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
    for (const line of [
      '[x](command:foo)[y]',
      '[source::`](https://example.invalid)`]',
      '[host::![i](https://example.invalid)]',
    ]) {
      const [content] = hover(line);
      expect(content).toBeDefined();
      expect(content!.isTrusted).toBeFalsy();
      expect(linkHrefs(content!.value)).toEqual([]);
    }
  });
});

/** The hover at `column` of the single line `line`, synchronous as a key or stanza hover is. */
function hoverAt(line: string, column: number, fileType: 'props.conf' | 'transforms.conf' = 'props.conf') {
  return createHoverProvider(fileType).provideHover(fakeModel(line), at(1, column), {} as never, undefined) as
    languages.Hover | null | undefined;
}

/** The directive hover of `line`'s key, as lines. */
function directiveHoverLines(line: string): string[] {
  const hover = hoverAt(line, line.search(/\S/) + 1);
  return (hover?.contents[0]?.value ?? '').split('\n');
}

function info(key: string): DirectiveInfo {
  const found = getDirectiveInfo(key, 'props.conf');
  if (!found) throw new Error(`no registry entry for ${key}`);
  return found;
}

describe('splunkConfHover — the stanza hover', () => {
  it('describes a sourcetype stanza, and covers the whole header', () => {
    const line = '[my:sourcetype]';
    const hover = hoverAt(line, 2)!;
    const { kind } = classifyStanza('my:sourcetype');
    expect(kind.patternSyntax).toEqual([]);
    expect(hover.contents[0]?.value).toBe(
      [
        `### \\[${escapeMarkdown('my:sourcetype')}\\]`,
        '',
        kind.description,
        '',
        `Applies to events with ${inlineCode('sourcetype=my:sourcetype')}.`,
        '',
        `**Precedence:** ${kind.precedence}`,
      ].join('\n'),
    );
    expect(hover.range).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: line.length + 1 });
  });

  it('names the pattern of a source stanza, and lists its pattern syntax', () => {
    const { kind, pattern } = classifyStanza('source::/var/log/*.log');
    expect(kind.patternSyntax.length).toBeGreaterThan(0);
    expect(hoverAt('[source::/var/log/*.log]', 2)?.contents[0]?.value).toBe(
      [
        `### \\[${escapeMarkdown('source::/var/log/*.log')}\\]`,
        '',
        kind.description,
        '',
        `Matching pattern: ${inlineCode(pattern ?? '')}`,
        '',
        `**Precedence:** ${kind.precedence}`,
        '',
        '**Pattern syntax:**',
        ...kind.patternSyntax.map((syntax) => `- ${syntax}`),
      ].join('\n'),
    );
  });

  it('gives [default] neither a sourcetype nor a pattern line', () => {
    const { kind } = classifyStanza('default');
    expect(hoverAt('[default]', 2)?.contents[0]?.value).toBe(
      ['### \\[default\\]', '', kind.description, '', `**Precedence:** ${kind.precedence}`].join('\n'),
    );
  });

  it.each(['[foo] bar', 'bar [foo]', '[foo'])('gives %j, which is not a whole header, no hover', (line) => {
    expect(hoverAt(line, 2)).toBeNull();
  });
});

describe('splunkConfHover — the directive hover', () => {
  it('lays out a simulated directive: heading, description, table, example and the dictionary link', () => {
    const kv = info('KV_MODE');
    const [stage] = getStagesForDirective('KV_MODE');
    expect(directiveHoverLines('KV_MODE = json')).toEqual([
      '### KV\\_MODE',
      '',
      kv.description,
      '',
      '| Property | Value |',
      '|----------|-------|',
      `| **Category** | ${kv.category} |`,
      `| **Phase** | ${kv.phase} |`,
      `| **Type** | ${kv.valueType} |`,
      `| **Default** | \`${kv.defaultValue}\` |`,
      `| **Applies to** | ${kv.appliesTo} |`,
      `| **Stage** | ${stage?.step}. ${stage?.name} |`,
      `| **Valid values** | ${(kv.enumValues ?? []).map((v) => `\`${v}\``).join(', ')} |`,
      '',
      '**Example:**',
      '```',
      kv.example,
      '```',
      '',
      `[Open in dictionary](${openDictionaryCommandUri('KV_MODE')})`,
    ]);
  });

  it('writes (none) for an empty default', () => {
    expect(info('TIME_PREFIX').defaultValue).toBe('');
    expect(directiveHoverLines('TIME_PREFIX = ^\\[')).toContain('| **Default** | `(none)` |');
  });

  it('leaves out the stage and valid-value rows when there are none', () => {
    const lines = directiveHoverLines('DATETIME_CONFIG = NONE');
    expect(lines.some((l) => l.startsWith('| **Stage**'))).toBe(false);
    expect(lines.some((l) => l.startsWith('| **Valid values**'))).toBe(false);
  });

  it('says "partly simulated" before the table, for a simulated directive with a note', () => {
    const lines = directiveHoverLines('TIME_FORMAT = %s');
    const note = lines.indexOf(`> **Partly simulated.** ${info('TIME_FORMAT').supportNote}`);
    expect(note).toBeGreaterThan(0);
    expect(lines[note + 1]).toBe('');
    expect(lines[note + 2]).toBe('| Property | Value |');
  });

  it('says "outside the simulation" for a documented directive', () => {
    const lines = directiveHoverLines('LINE_BREAKER_LOOKBEHIND = 100');
    expect(lines).toContain(`> ℹ️ **Outside the simulation.** ${info('LINE_BREAKER_LOOKBEHIND').supportNote}`);
    expect(directiveHoverLines('ZZ_DOCUMENTED_BARE = 1')).toContain('> ℹ️ **Outside the simulation.**');
  });

  it('says "not simulated" for an ignored directive, with the issue that tracks it', () => {
    expect(directiveHoverLines('ZZ_IGNORED_TRACKED = 1')).toContain(
      '> ⚠️ **Not simulated.** The preview skips it. Tracked as #42.',
    );
    expect(directiveHoverLines('ZZ_IGNORED_BARE = 1')).toContain('> ⚠️ **Not simulated.**');
  });

  it('marks a deprecated directive, before the dictionary link', () => {
    expect(directiveHoverLines('CHECK_FOR_HEADER = false').slice(-4)).toEqual([
      '',
      '> **Deprecated:** This directive is deprecated and may be removed in future versions.',
      '',
      `[Open in dictionary](${openDictionaryCommandUri('CHECK_FOR_HEADER')})`,
    ]);
  });

  it('names the class of a class-based key, and keeps a hyphen in the class', () => {
    expect(directiveHoverLines('EXTRACT-client_ip = (?<ip>\\S+)').slice(0, 2)).toEqual([
      '### EXTRACT\\-client\\_ip',
      `*Class-based directive* (${inlineCode('EXTRACT-<client_ip>')})`,
    ]);
    expect(directiveHoverLines('EXTRACT-a-b = (?<a>.)')[1]).toBe(
      `*Class-based directive* (${inlineCode('EXTRACT-<a-b>')})`,
    );
  });

  it('covers the key as typed, past its indent', () => {
    const hover = hoverAt('  KV_MODE = json', 3)!;
    expect(hover.range).toEqual({ startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 10 });
  });

  it('answers up to and on the "=", and not past it for a directive that is not a time format', () => {
    // KV_MODE is 7 characters and the "=" is at index 8, column 9.
    expect(hoverAt('KV_MODE = json', 9)?.contents[0]?.value).toMatch(/^### KV\\_MODE/);
    expect(hoverAt('KV_MODE = json', 10)).toBeNull();
  });

  it.each(['= json', 'KV_MODE json', 'NOT_A_DIRECTIVE = 1'])('gives %j no hover', (line) => {
    expect(hoverAt(line, 1)).toBeNull();
  });
});
