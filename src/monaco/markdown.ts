// ---------------------------------------------------------------------------
// markdown.ts
// Put document text into Monaco hover/completion Markdown as text, never as
// Markdown syntax (#296).
//
// Hover content is Markdown, and some of it is trusted so the "Open in
// dictionary" `command:` link works. Anything a user typed — a directive key, a
// class name, a stanza name, a sample line — that is interpolated raw can close
// the surrounding construct and open its own: a key of
// `EXTRACT-x](command:foo)[` turned the heading into a clickable command link.
// Every user-derived string goes through one of these two helpers instead.
// ---------------------------------------------------------------------------

/**
 * Every ASCII punctuation character that can begin, end or alter a Markdown
 * construct: emphasis, code, links and images, headings, lists, tables, HTML,
 * strikethrough, entities. CommonMark allows a backslash before ANY ASCII
 * punctuation, so over-escaping is harmless while under-escaping is the bug.
 *
 * `:` is on the list for GFM's bare-URL autolinks, which need no brackets at
 * all: marked still links `https://example\.invalid` with its dots escaped, and
 * only an escaped colon stops the scheme being recognised.
 */
const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~:&]/g;

/** Escape `text` so Markdown renders it literally, for use in running text. */
export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, '\\$&');
}

/**
 * Wrap `text` in a code span that it cannot close.
 *
 * Backslash escapes are NOT processed inside a code span, so `escapeMarkdown`
 * would show its backslashes there and still let a backtick end the span.
 * CommonMark's own answer is a fence longer than any backtick run in the
 * content, padded with a space when the content starts or ends with a backtick
 * or a space (one space each side is stripped again on render).
 */
export function inlineCode(text: string): string {
  if (text === '') return '` `';
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
