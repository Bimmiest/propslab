// The rule against a module-level `let` (#856), and the page-level singletons
// that pass it by name (#865). A selector is easy to break without a failure:
// one that matches nothing reports nothing, and an exception that is too wide
// lets every `let` in its file pass. This lints real lines with the rule as
// eslint.config.js resolves it for each file.

import { describe, it, expect } from 'vitest';
import { ESLint, Linter } from 'eslint';

// The config is found from the working directory, which vitest leaves at the repository root.
const eslint = new ESLint();
const RULE = 'no-restricted-syntax';

interface ResolvedConfig {
  rules?: Record<string, unknown>;
}

/** The messages `no-restricted-syntax` gives `code`, as configured for the file at `filePath`. */
async function reported(filePath: string, code: string): Promise<string[]> {
  const resolved = (await eslint.calculateConfigForFile(filePath)) as ResolvedConfig | undefined;
  const setting = resolved?.rules?.[RULE];
  if (setting === undefined) return [];
  const linter = new Linter();
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: { sourceType: 'module' },
        rules: { [RULE]: setting as Linter.RuleEntry },
      },
    ],
    { filename: filePath },
  );
  return messages.map((m) => m.message);
}

const STATE = /Do not keep state that changes at module level/;

describe('a module-level let', () => {
  it('is reported at the top level and in an export, in shipped code', async () => {
    expect(await reported('src/utils/clipboard.ts', 'let count = 0;\n')).toEqual([expect.stringMatching(STATE)]);
    expect(await reported('src/utils/clipboard.ts', 'export let count = 0;\n')).toEqual([expect.stringMatching(STATE)]);
  });

  it('is not reported inside a function, or as a const', async () => {
    expect(await reported('src/utils/clipboard.ts', 'export function f() {\n  let n = 0;\n  return n;\n}\n')).toEqual(
      [],
    );
    expect(await reported('src/utils/clipboard.ts', 'const count = 0;\n')).toEqual([]);
  });

  it('is not reported in a test, where beforeEach shares a fixture', async () => {
    expect(await reported('src/utils/__tests__/clipboard.test.ts', 'let fixture = 0;\n')).toEqual([]);
  });
});

describe('the page-level singletons', () => {
  it.each([
    ['src/staleChunkReload.ts', 'reloading'],
    ['src/staleChunkReload.ts', 'carriedOver'],
    ['src/components/editor/revealInEditor.ts', 'cancelPending'],
    ['src/components/ui/retryableLazy.tsx', 'resetEpoch'],
    ['src/components/editor/splunkMonacoSetup.ts', 'registration'],
    ['src/monaco/timePrefixMatcher.ts', 'nextId'],
    ['src/workers/regexEngineLoader.ts', 'loading'],
    ['src/test/fcSeed.ts', 'seedLogged'],
  ])('%s may keep `let %s`', async (file, name) => {
    expect(await reported(file, `let ${name} = 0;\n`)).toEqual([]);
  });

  it('still reports any other let in the same file', async () => {
    expect(await reported('src/staleChunkReload.ts', 'let somethingElse = 0;\n')).toEqual([
      expect.stringMatching(STATE),
    ]);
  });

  it('allows a name only in its own file', async () => {
    expect(await reported('src/staleChunkReload.ts', 'let resetEpoch = 0;\n')).toEqual([expect.stringMatching(STATE)]);
    expect(await reported('src/utils/clipboard.ts', 'let reloading = false;\n')).toEqual([
      expect.stringMatching(STATE),
    ]);
  });

  it('does not allow a name that only starts with an allowed one', async () => {
    expect(await reported('src/staleChunkReload.ts', 'let reloadingSoon = false;\n')).toEqual([
      expect.stringMatching(STATE),
    ]);
  });
});
