// The engine's import boundary (#510). It runs under Node and inside the MCP
// server, so it may not reach UI code, the store, the editor integration, React
// or Monaco. The rule that enforces this was once written with `name:` entries,
// which are exact module specifiers: '**/components/**' matched no import and the
// boundary held only because nobody had crossed it. This test lints real import
// lines with the rule as eslint.config.js resolves it for an engine file, so the
// config can be broken again only by a test failing.
//
// Only the rule is exercised, on plain imports: the point is which specifiers it
// reports, not type-aware parsing, so no project service is started.

import { describe, it, expect } from 'vitest';
import { ESLint, Linter } from 'eslint';

// The config is found from the working directory, which vitest leaves at the repository root.
const eslint = new ESLint();
const RULE = 'no-restricted-imports';

interface ResolvedConfig {
  rules?: Record<string, unknown>;
}

/** The messages `no-restricted-imports` gives `code`, as configured for the file at `filePath`. */
async function restricted(filePath: string, code: string): Promise<string[]> {
  const resolved = (await eslint.calculateConfigForFile(filePath)) as ResolvedConfig | undefined;
  const setting = resolved?.rules?.[RULE];
  if (setting === undefined) return [];
  const linter = new Linter();
  const messages = linter.verify(
    code,
    [{ files: ['**/*.ts'], languageOptions: { sourceType: 'module' }, rules: { [RULE]: setting as Linter.RuleEntry } }],
    { filename: filePath },
  );
  return messages.map((m) => m.message);
}

const importing = (specifier: string) => `import { x } from '${specifier}';\n`;

describe('the engine import boundary', () => {
  it.each([
    ['src/engine/a.ts', '../components/foo'],
    ['src/engine/a.ts', '../components'],
    ['src/engine/processors/b.ts', '../../hooks/x'],
    ['src/engine/processors/b.ts', '../../hooks'],
    ['src/engine/a.ts', '../store/x'],
    ['src/engine/a.ts', '../store/useAppStore'],
    ['src/engine/a.ts', '../monaco/splunkConfHover'],
    ['src/engine/transforms/c.ts', '../../components/preview/tabs/RawTab'],
    ['src/engine/a.ts', '../../src/store/x'],
    ['src/engine/a.ts', 'react'],
    ['src/engine/a.ts', 'react/jsx-runtime'],
    ['src/engine/a.ts', 'react-dom/client'],
    ['src/engine/a.ts', 'zustand'],
    ['src/engine/a.ts', 'zustand/middleware'],
    ['src/engine/a.ts', 'monaco-editor'],
    ['src/engine/a.ts', 'monaco-editor/esm/vs/editor/editor.api'],
  ])('reports %s importing %s', async (file, specifier) => {
    expect(await restricted(file, importing(specifier))).toHaveLength(1);
  });

  it.each([
    ['src/engine/a.ts', './types'],
    ['src/engine/processors/b.ts', '../types'],
    ['src/engine/processors/eval/c.ts', '../../../utils/splunkRegex'],
    ['src/engine/a.ts', '../utils/strftime'],
    ['src/engine/a.ts', 'pcre2-wasm-utf16'],
    ['src/engine/a.ts', 'node:path'],
  ])('allows %s importing %s', async (file, specifier) => {
    expect(await restricted(file, importing(specifier))).toEqual([]);
  });

  it('reports a re-export as well as an import', async () => {
    expect(await restricted('src/engine/a.ts', "export { x } from '../components/foo';\n")).toHaveLength(1);
  });

  it('leaves the rest of the app alone', async () => {
    expect(await restricted('src/components/A.tsx', importing('../store/useAppStore'))).toEqual([]);
    expect(await restricted('src/hooks/useThing.ts', importing('../components/foo'))).toEqual([]);
  });

  it('exempts the engine tests', async () => {
    expect(await restricted('src/engine/__tests__/x.test.ts', importing('../../monaco/splunkConfDiagnostics'))).toEqual([]);
  });
});
