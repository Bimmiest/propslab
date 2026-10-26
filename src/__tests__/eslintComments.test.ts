// The two comment rules from repo-template (scripts/eslint-comments.mjs, #731),
// on real comments: what each reports, and what it lets through.
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import comments from '../../scripts/eslint-comments.mjs';

function reports(code: string): (string | null)[] {
  return new Linter()
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser, sourceType: 'module' },
          plugins: { comments },
          rules: { 'comments/todo-has-issue': 'error', 'comments/no-commented-out-code': 'error' },
        },
      ],
      { filename: 'x.ts' },
    )
    .map((m) => m.ruleId);
}

describe('comments/todo-has-issue', () => {
  it.each(['// TODO fix this', '// FIXME: later', '/*\n * XXX check\n */', '// TODO(123): no hash'])(
    'reports %j',
    (c) => {
      expect(reports(`${c}\nexport const a = 1;\n`)).toEqual(['comments/todo-has-issue']);
    },
  );

  it.each(['// TODO(#12): fix this', '// A row that is unclear is a TODO with a reason.'])('passes %j', (c) => {
    expect(reports(`${c}\nexport const a = 1;\n`)).toEqual([]);
  });
});

describe('comments/no-commented-out-code', () => {
  it.each(['// const x = compute(a);\n// return x;', '// doThing(a, b);', '// if (a) {\n//   b();\n// }'])(
    'reports %j',
    (c) => {
      expect(reports(`${c}\nexport const a = 1;\n`)).toEqual(['comments/no-commented-out-code']);
    },
  );

  it.each([
    '// Keep the slot until the worker exits.',
    '// https://example.com/path',
    '// shortcut: one pass only, until inputs pass 10 MB.',
    '// See docs/adr/0016-recorded-splunk-output-is-not-distributed.md.',
  ])('passes %j', (c) => {
    expect(reports(`${c}\nexport const a = 1;\n`)).toEqual([]);
  });
});
