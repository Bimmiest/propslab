// Setup file: records which directive keys each test file actually feeds to
// `runPipeline`, for `src/engine/__tests__/directiveEvidence.test.ts`.
//
// Why a recorder rather than a search of the test sources. "This directive is
// exercised" used to mean "its name followed by `=` appears somewhere in any
// test file", which a lint test, a registry test or a comment satisfies without
// the engine ever running the directive (#505). What counts is the parsed conf
// that reaches the pipeline, so that is what is recorded: `runPipeline` is
// wrapped, each conf it is handed is run through the real `parseConf`, and the
// directive keys found go to a file named for the calling test file.
//
// Why files, and one per test file. Vitest runs test files in parallel workers
// that share no memory. Each worker appends nothing to anything shared: it
// writes its own file once, in `afterAll`, so there is no write contention and
// no ordering to depend on. The reader (directiveEvidence.test.ts) runs in a
// later vitest project (`sequence.groupOrder` in vitest.config.ts), so every
// one of those files exists by the time it looks.
//
// The directory comes from `PROPSLAB_EVIDENCE_DIR`, set once by vitest.config.ts
// in the main process and inherited by every worker. Without it (a Stryker run,
// which uses its own config) this file does nothing and costs nothing.

import { afterAll, expect, vi } from 'vitest';

interface Fs {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
}

const recorded = vi.hoisted(() => ({ keys: new Set<string>() }));

vi.mock('../engine/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/pipeline')>();
  const { parseConf } = await import('../engine/parser/confParser');
  const { env } = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
  const dir = env['PROPSLAB_EVIDENCE_DIR'];
  if (!dir) return actual;

  const runPipeline: typeof actual.runPipeline = (raw, metadata, props, transforms, options) => {
    // Recording must never change what a test observes, so a conf the parser
    // cannot read is left for runPipeline to report as it always has.
    try {
      for (const [input, file] of [
        [props, 'props.conf'],
        [transforms, 'transforms.conf'],
      ] as const) {
        for (const stanza of parseConf(input, file).stanzas) {
          for (const d of stanza.directives) recorded.keys.add(d.directiveType);
        }
      }
    } catch {
      // see above
    }
    return actual.runPipeline(raw, metadata, props, transforms, options);
  };
  return { ...actual, runPipeline };
});

afterAll(() => {
  const proc = (
    globalThis as unknown as {
      process: { env: Record<string, string | undefined>; getBuiltinModule: (id: 'node:fs') => Fs };
    }
  ).process;
  const dir = proc.env['PROPSLAB_EVIDENCE_DIR'];
  const testPath = expect.getState().testPath;
  if (!dir || !testPath || recorded.keys.size === 0) return;

  const fs = proc.getBuiltinModule('node:fs');
  const testFile = testPath.slice(testPath.lastIndexOf('/src/') + 1);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    `${dir}/${testFile.replaceAll('/', '__')}.json`,
    JSON.stringify({ testFile, keys: [...recorded.keys].sort() }),
  );
});
