// The clock rule for tests (#572): runPipeline falls back to Date.now(), so a
// test passes `now` in its options, the fifth argument. The rule is
// `no-restricted-syntax` with esquery selectors, which match nothing at all if
// mistyped; this lints real calls with the rule as eslint.config.js resolves it
// for a test file, as eslintBoundary.test.ts does for the engine's imports.

import { describe, it, expect } from 'vitest';
import { ESLint, Linter } from 'eslint';

const eslint = new ESLint();
const RULE = 'no-restricted-syntax';
const TEST_FILE = 'src/components/__tests__/x.test.ts';

/** How many times the rule, as configured for a test file, reports `code`. */
async function reports(code: string): Promise<number> {
  const resolved = (await eslint.calculateConfigForFile(TEST_FILE)) as { rules?: Record<string, unknown> } | undefined;
  const setting = resolved?.rules?.[RULE];
  if (setting === undefined) return 0;
  const linter = new Linter();
  return linter.verify(
    code,
    [{ files: ['**/*.ts'], languageOptions: { sourceType: 'module' }, rules: { [RULE]: setting as Linter.RuleEntry } }],
    { filename: TEST_FILE },
  ).length;
}

describe('runPipeline in a test names its clock', () => {
  it.each(["runPipeline(raw, meta, props, '');", "runPipeline(raw, meta, props, '', { perEventPipeline: false });"])(
    'reports %s',
    async (call) => {
      expect(await reports(call)).toBe(1);
    },
  );

  it.each([
    "runPipeline(raw, meta, props, '', { perEventPipeline: false, now: FIXED_NOW });",
    "runPipeline(raw, meta, props, '', AT_FIXED_NOW);",
    "runPipeline(raw, meta, props, '', opts(now));",
    "runPipeline(raw, meta, props, '', { ...AT_FIXED_NOW, captureOffsets: true });",
    'runPipeline(...args);',
  ])('passes %s', async (call) => {
    expect(await reports(call)).toBe(0);
  });
});
