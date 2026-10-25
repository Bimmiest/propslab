// Whether a change to a file can be skipped by mutation testing: it changes
// formatting or comments and nothing else. Such a change cannot alter what the
// code does, so it gives mutation testing nothing new to test. Text that does
// not parse is never skippable.
//
// One test covers both, because the code tokens leave out layout as well as
// comments. A Prettier comparison used to sit beside it, but CI holds every
// file to Prettier, so both sides were already its output and it could only
// say "yes" for text that had not changed (#571). The cost: a Prettier upgrade
// that adds a token, a semicolon or a parenthesis, makes the files it touches
// count as changed, and they are mutated once.

import ts from 'typescript';

/**
 * Comments that change which mutants Stryker generates. A change to one of
 * these is a change to the mutation run, so it is never comment-only.
 */
const STRYKER_DIRECTIVE = /\bStryker\s+(?:disable|restore)\b[^\n]*/gi;

/**
 * The file's code as a list of tokens, with every comment and all layout left
 * out, or null when the text does not parse. The tokens are the leaves of the
 * TypeScript syntax tree rather than a scan of the text, so a `//` or `/*`
 * inside a string, template or regex literal is never mistaken for a comment.
 *
 * Stryker directives are the exception: each is a token where it stands, since
 * it governs the code after it, so moving one is a change to the code (#571).
 *
 * @param {string} filePath
 * @param {string} text
 * @returns {string[] | null}
 */
function codeTokens(filePath, text) {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  // `parseDiagnostics` is not in the public typings, but it is where the
  // parser records syntax errors; a file with any is never skippable.
  if (/** @type {{ parseDiagnostics?: unknown[] }} */ (source).parseDiagnostics?.length) return null;
  /** @type {string[]} */
  const tokens = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    // JSDoc blocks are children in the tree, but they are comments.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
        for (const directive of text.slice(range.pos, range.end).match(STRYKER_DIRECTIVE) ?? []) {
          tokens.push(`directive ${directive.trim()}`);
        }
      }
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(`${String(node.kind)} ${node.getText(source)}`);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(source);
  return tokens;
}

/**
 * Whether only comments changed, with or without formatting: the code's
 * tokens are the same on both sides, Stryker directives and where they stand
 * included.
 *
 * @param {string} filePath Path used to pick the parser (`.ts`, `.tsx`, `.mjs`, ...).
 * @param {string} before The file's text on the base branch.
 * @param {string} after The file's text now.
 * @returns {boolean}
 */
export function isCommentOnly(filePath, before, after) {
  const b = codeTokens(filePath, before);
  const a = codeTokens(filePath, after);
  return b !== null && a !== null && a.join('\n') === b.join('\n');
}
