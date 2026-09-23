import { describe, it, expect } from 'vitest';
// The Markdown parser Monaco renders hovers with: monaco-editor 0.55 bundles
// marked 14.0.0 and depends on the same version, so parsing with it here shows
// what the hover would actually produce rather than what a regex guesses.
import { marked, type Token } from 'marked';
import { escapeMarkdown, inlineCode } from '../markdown';

/** Every token in a parsed document, depth-first. */
function allTokens(markdown: string): Token[] {
  const out: Token[] = [];
  void marked.walkTokens(marked.lexer(markdown), (t) => {
    out.push(t);
  });
  return out;
}

/** The plain text Markdown renders for `markdown`, with tags stripped. */
function renderedText(markdown: string): string {
  const html = marked.parseInline(markdown, { async: false });
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Strings that would each open some construct if interpolated raw.
const HOSTILE = [
  'EXTRACT-x](command:foo)[',
  '[click](command:workbench.action.terminal.new)',
  '![img](https://example.invalid/x.png)',
  '**bold** _em_ ~~strike~~',
  '`code` ``two``',
  '<img src=x onerror=alert(1)>',
  '# heading',
  '- list',
  '+ list',
  '1. list',
  'a | b | c',
  '{curly} (paren) \\back\\slash!',
  'see https://example.invalid/path or www.example.invalid',
  '&lt;b&gt; &#91;',
];

describe('escapeMarkdown (#296)', () => {
  it.each(HOSTILE)('renders %s as exactly that text, with no link, image, code or HTML', (text) => {
    const md = `### ${escapeMarkdown(text)}`;
    const types = new Set(allTokens(md).map((t) => t.type));
    for (const forbidden of ['link', 'image', 'codespan', 'strong', 'em', 'del', 'html', 'list']) {
      expect(types.has(forbidden)).toBe(false);
    }
    expect(renderedText(escapeMarkdown(text))).toBe(text);
  });

  it('escapes each character the issue lists', () => {
    expect(escapeMarkdown('\\`*_{}[]()#+-.!|<>')).toBe('\\\\\\`\\*\\_\\{\\}\\[\\]\\(\\)\\#\\+\\-\\.\\!\\|\\<\\>');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeMarkdown('TIME_PREFIX')).toBe('TIME\\_PREFIX');
    expect(escapeMarkdown('plain words 123')).toBe('plain words 123');
  });
});

describe('inlineCode (#296)', () => {
  it.each([...HOSTILE, 'a`b', '`lead', 'trail`', '``', ' spaced ', 'x'])(
    'keeps %s inside one code span with its text intact',
    (text) => {
      const tokens = allTokens(inlineCode(text));
      const spans = tokens.filter((t) => t.type === 'codespan');
      expect(spans).toHaveLength(1);
      expect(tokens.some((t) => t.type === 'link' || t.type === 'image' || t.type === 'html')).toBe(false);
      expect(renderedText(inlineCode(text))).toBe(text);
    },
  );

  it('uses a single backtick fence when the text needs no more', () => {
    expect(inlineCode('%Y-%m-%d')).toBe('`%Y-%m-%d`');
  });

  it('renders something for the empty string rather than a bare fence', () => {
    expect(inlineCode('')).toBe('` `');
  });
});
