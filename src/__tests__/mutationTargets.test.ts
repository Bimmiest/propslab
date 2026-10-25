import { describe, it, expect } from 'vitest';
import { importedSources, isTestFile, MUTATE_GLOBS, selectMutated } from '../../scripts/lib/mutationTargets.mjs';

// The PR selection in mutation.yml (#571): which changed files a mutation run
// mutates, read from Stryker's own `mutate` list.
const globs = MUTATE_GLOBS;

describe('selectMutated', () => {
  it("keeps what Stryker's mutate globs select, and drops what they exclude", () => {
    expect(
      selectMutated(
        [
          'src/engine/pipeline.ts',
          'src/engine/processors/lineBreaker.ts',
          'src/utils/splunkRegex.ts',
          'src/store/useAppStore.ts',
          'src/engine/types.ts',
          'src/engine/pipelineWorker.ts',
          'src/engine/registry/propsDirectives.ts',
          'src/engine/directiveSupport.ts',
          'src/engine/__tests__/lineBreaker.test.ts',
          'src/utils/regexSyntax.ts',
          'packages/mcp-server/src/tools.ts',
          'docs/engine.md',
        ],
        globs,
      ),
    ).toEqual([
      'src/engine/pipeline.ts',
      'src/engine/processors/lineBreaker.ts',
      'src/utils/splunkRegex.ts',
      'src/store/useAppStore.ts',
    ]);
  });

  it('reads `**/` as zero or more directories and `*` as one name', () => {
    expect(selectMutated(['a/b.ts', 'a/x/y/b.ts', 'a/b/c.ts'], ['a/**/b.ts'])).toEqual(['a/b.ts', 'a/x/y/b.ts']);
    expect(selectMutated(['a/b.ts', 'a/x/b.ts'], ['a/*.ts'])).toEqual(['a/b.ts']);
    expect(selectMutated(['a.ts', 'a+ts'], ['a.ts'])).toEqual(['a.ts']);
  });
});

describe('isTestFile', () => {
  it('is true for tests and their support files', () => {
    expect(isTestFile('src/engine/__tests__/runCtx.ts')).toBe(true);
    expect(isTestFile('src/engine/foo.test.ts')).toBe(true);
    expect(isTestFile('src/components/x/X.test.tsx')).toBe(true);
    expect(isTestFile('src/engine/pipeline.ts')).toBe(false);
  });
});

describe('importedSources', () => {
  it('resolves relative imports to the files that exist, with or without an index', () => {
    const exists = (p: string) =>
      ['src/engine/pipeline.ts', 'src/engine/processors/lineBreaker.ts', 'src/engine/utils/index.ts'].includes(p);
    const source = [
      "import { describe } from 'vitest';",
      "import { runPipeline } from '../pipeline';",
      "import { breakLines } from '../processors/lineBreaker';",
      "import { x } from '../utils';",
      "import { gone } from '../missing';",
    ].join('\n');
    expect(importedSources('src/engine/__tests__/a.test.ts', source, exists)).toEqual([
      'src/engine/pipeline.ts',
      'src/engine/processors/lineBreaker.ts',
      'src/engine/utils/index.ts',
    ]);
  });
});
