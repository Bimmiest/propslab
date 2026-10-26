// The two comment rules in CONTRIBUTING ("Code comments") that a tool can
// check. A local plugin, not a dependency: each rule is a few lines.
import tseslint from 'typescript-eslint';

/** Statements that only code makes. A sentence that happens to parse, or a URL (`https:` is a label), makes none of them. */
const CODE = new Set([
  'VariableDeclaration',
  'FunctionDeclaration',
  'ClassDeclaration',
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ReturnStatement',
  'IfStatement',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'ThrowStatement',
  'TryStatement',
]);
const CODE_EXPRESSIONS = new Set(['CallExpression', 'AssignmentExpression', 'AwaitExpression', 'NewExpression']);

/** Whether `text` parses as statements that only code makes. */
function isCode(text) {
  try {
    const { ast } = tseslint.parser.parseForESLint(text, {
      sourceType: 'module',
      ecmaVersion: 'latest',
      ecmaFeatures: { jsx: true },
    });
    return ast.body.some(
      (node) =>
        CODE.has(node.type) || (node.type === 'ExpressionStatement' && CODE_EXPRESSIONS.has(node.expression.type)),
    );
  } catch {
    return false;
  }
}

/** Runs of `//` comments on consecutive lines, each as one block of text. */
function lineCommentRuns(comments) {
  const runs = [];
  for (const comment of comments) {
    if (comment.type !== 'Line') continue;
    const last = runs.at(-1);
    if (last && last.end.loc.end.line === comment.loc.start.line - 1) {
      last.end = comment;
      last.text += `\n${comment.value}`;
    } else {
      runs.push({ start: comment, end: comment, text: comment.value });
    }
  }
  return runs;
}

/** @type {import('eslint').ESLint.Plugin} */
export default {
  rules: {
    'todo-has-issue': {
      meta: {
        type: 'suggestion',
        docs: { description: 'A TODO, FIXME or XXX names its issue: TODO(#123).' },
        messages: { noIssue: 'Name the issue: TODO(#123): what is left to do.' },
        schema: [],
      },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (/^\s*(?:\*\s*)?(?:TODO|FIXME|XXX)\b(?!\(#\d+\))/m.test(comment.value)) {
                context.report({ loc: comment.loc, messageId: 'noIssue' });
              }
            }
          },
        };
      },
    },
    'no-commented-out-code': {
      meta: {
        type: 'suggestion',
        docs: { description: 'No commented-out code: git keeps the old version.' },
        messages: { code: 'This comment is code. Delete it: git keeps the old version.' },
        schema: [],
      },
      create(context) {
        return {
          Program() {
            for (const run of lineCommentRuns(context.sourceCode.getAllComments())) {
              if (isCode(run.text)) {
                context.report({ loc: { start: run.start.loc.start, end: run.end.loc.end }, messageId: 'code' });
              }
            }
          },
        };
      },
    },
  },
};
