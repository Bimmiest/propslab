// The import-order rule (#510): Node built-ins, then packages, then the
// project's own files, with `--fix` doing the reordering. Like eslintBoundary
// this lints real code with the rule as eslint.config.js resolves it for a file,
// so the config cannot stop matching without a test failing.
//
// Only the rule is exercised, on plain JavaScript imports, so no project service
// is started.

import { describe, it, expect } from 'vitest';
import { ESLint, Linter } from 'eslint';
import importX from 'eslint-plugin-import-x';

const eslint = new ESLint();
const RULE = 'import-x/order';

interface ResolvedConfig {
  rules?: Record<string, unknown>;
}

async function linterFor(filePath: string): Promise<{ config: Linter.Config[]; enabled: boolean }> {
  const resolved = (await eslint.calculateConfigForFile(filePath)) as ResolvedConfig | undefined;
  const setting = resolved?.rules?.[RULE];
  return {
    enabled: setting !== undefined,
    config: [
      {
        files: ['**/*.{ts,js}'],
        languageOptions: { sourceType: 'module' },
        plugins: { 'import-x': importX },
        rules: setting === undefined ? {} : { [RULE]: setting as Linter.RuleEntry },
      },
    ],
  };
}

/** What the rule reports for `code`. */
async function reported(filePath: string, code: string): Promise<string[]> {
  const { config } = await linterFor(filePath);
  return new Linter().verify(code, config, { filename: filePath }).map((m) => m.message);
}

/** `code` after the rule's fix. */
async function fixed(filePath: string, code: string): Promise<string> {
  const { config } = await linterFor(filePath);
  return new Linter().verifyAndFix(code, config, { filename: filePath }).output;
}

const FILE = 'src/utils/a.ts';

describe('the import-order rule', () => {
  it('is on for the app, the engine, the MCP server, the e2e specs and the scripts', async () => {
    for (const file of [
      'src/components/A.tsx',
      'src/engine/a.ts',
      'packages/mcp-server/src/tools.ts',
      'e2e/a.spec.ts',
      'scripts/check-node-patch.mjs',
      'eslint.config.js',
    ]) {
      expect((await linterFor(file)).enabled, file).toBe(true);
    }
  });

  it.each([
    ["import a from './a';\nimport b from 'react';\n", 'react'],
    ["import a from '../a';\nimport b from 'zod';\n", 'zod'],
    ["import a from 'react';\nimport b from 'node:path';\n", 'node:path'],
    ["import a from '../a';\nimport b from 'node:url';\n", 'node:url'],
  ])('reports a later import that should come first: %j', async (code, first) => {
    const messages = await reported(FILE, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`\`${first}\``);
  });

  it('takes built-ins, then packages, then the project’s own files, in any order among the last', async () => {
    const code = [
      "import path from 'node:path';",
      "import react from 'react';",
      "import up from '../up';",
      "import sibling from './sibling';",
      "import up2 from '../../up2';",
      "import index from './';",
      '',
    ].join('\n');
    expect(await reported(FILE, code)).toEqual([]);
  });

  it('does not order a side-effect import, so one that must run first can stay first', async () => {
    const code = "import '../test/setup';\nimport react from 'react';\nimport local from './local';\n";
    expect(await reported(FILE, code)).toEqual([]);
  });

  it('fixes an out-of-order file by moving the declarations', async () => {
    const out = await fixed(FILE, "import a from './a';\nimport b from 'react';\nimport c from 'node:path';\n");
    expect(out).toBe("import c from 'node:path';\nimport b from 'react';\nimport a from './a';\n");
  });
});
