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
// Only the stanzas that applied count (#569). A key in a props stanza that
// matched none of the run's metadata, or in a transforms stanza that no applied
// props stanza names, never ran, so it is no evidence. The metadata are the
// input's, each event's as the run left it (a CLONE_SOURCETYPE copy, a
// DEST_KEY = MetaData:* rewrite) and a `rename` target. This is still a proxy:
// it does not see whether the directive changed anything, or whether the test
// asserted on it.
//
// Why files, and one per test file. Vitest runs test files in parallel workers
// that share no memory. Each worker appends nothing to anything shared: it
// writes its own file once, in `afterAll`, so there is no write contention and
// no ordering to depend on. The reader (directiveEvidence.test.ts) runs in a
// later vitest project (`sequence.groupOrder` in vitest.config.ts), so every
// one of those files exists by the time it looks.
//
// The directory comes from `PROPSLAB_EVIDENCE_DIR`, which vitest.config.ts sets
// in the main process, for a full run only, and every worker inherits. Without
// it (a single file, a project, a shard, watch mode, a Stryker run) this file
// does nothing and costs nothing.

import { afterAll, expect, vi } from 'vitest';

interface Fs {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
}

const recorded = vi.hoisted(() => ({ keys: new Set<string>() }));

/** props.conf keys whose value names transforms.conf stanzas. */
const REFERENCES = new Set(['TRANSFORMS', 'REPORT', 'RULESET']);

vi.mock('../engine/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/pipeline')>();
  const { parseConf } = await import('../engine/parser/confParser');
  const { matchStanzas, resolveStanzasForEvent } = await import('../engine/parser/stanzaMatcher');
  const { env } = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
  const dir = env['PROPSLAB_EVIDENCE_DIR'];
  if (!dir) return actual;

  const runPipeline: typeof actual.runPipeline = (raw, metadata, props, transforms, options) => {
    const output = actual.runPipeline(raw, metadata, props, transforms, options);
    // Recording must never change what a test observes, so a conf the parser
    // cannot read is left for runPipeline to report as it always has.
    try {
      const { result } = output;
      const metas = [metadata, result.inputMetadata, ...result.events.map((e) => e.metadata)];
      if (result.renamedSourcetype !== undefined) {
        metas.push({ ...result.inputMetadata, sourcetype: result.renamedSourcetype });
      }
      const propsStanzas = parseConf(props, 'props.conf').stanzas;
      const applied = new Set(
        metas.flatMap((m) => [...matchStanzas(propsStanzas, m), ...resolveStanzasForEvent(propsStanzas, m).stanzas]),
      );
      const named = new Set<string>();
      for (const stanza of applied) {
        for (const d of stanza.directives) {
          recorded.keys.add(d.directiveType);
          if (REFERENCES.has(d.directiveType)) for (const name of d.value.split(',')) named.add(name.trim());
        }
      }
      // `disabled` works by keeping its stanza from applying, so it counts
      // where its stanza would have matched without it.
      const dormant = propsStanzas
        .filter((stanza) => stanza.directives.some((d) => d.directiveType === 'disabled'))
        .map((stanza) => ({ ...stanza, directives: stanza.directives.filter((d) => d.directiveType !== 'disabled') }));
      if (metas.some((m) => matchStanzas(dormant, m).length > 0)) recorded.keys.add('disabled');
      for (const stanza of parseConf(transforms, 'transforms.conf').stanzas) {
        if (named.has(stanza.name)) for (const d of stanza.directives) recorded.keys.add(d.directiveType);
      }
    } catch {
      // see above
    }
    return output;
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
