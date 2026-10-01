// ---------------------------------------------------------------------------
// directiveEvidence.test.ts
// What backs each directive that DIRECTIVE_SUPPORT calls `simulated`.
//
// A `simulated` directive is a claim that the engine reproduces Splunk. Two
// things can stand behind it, stronger first:
//
//   cited     a test that really runs it through the pipeline, in a file whose
//             comments say the expectation was derived from the spec ("Doc-derived",
//             the .spec file, and the directive's name in one comment).
//   exercised a test runs it through the pipeline, and nothing more is said.
//
// A directive with neither is a claim with no evidence, and this file fails on
// it. A directive with only "exercised" must be reclassified `documented` in
// directiveSupport.ts, or sit in DOC_UNCITED below, which can only shrink.
//
// Only tests committed to this repository count. Anything under
// src/engine/__tests__/private/ (git-ignored, for local-only tests) is left
// out, so the verdict here is the one CI gives.
//
// HOW "EXERCISED" IS DECIDED (#505)
//
// It used to be a regex over the raw source of every test file, so `KEY =` in a
// comment, a lint test or a registry test counted. It is now measured: the
// `recordDirectiveEvidence` setup file (src/test/) wraps `runPipeline` in every
// test worker, parses the confs it is handed with the real `parseConf`, and
// writes the directive keys it found to one file per test file. This test reads
// those files.
//
// Why recorded and not extracted statically. Tests build their confs through
// helpers, template strings and shared constants; a static pass would have to
// resolve all of that, and would miss what it could not. Recording sees the
// conf that actually reached the pipeline, whatever built it.
//
// Why it is not flaky under parallel workers. Workers share no memory and no
// file: each writes only its own file, once, at the end of its test file, so
// nothing is appended concurrently. And this test is in its own vitest project
// (`evidence`, vitest.config.ts) with a higher `sequence.groupOrder` than
// everything else, which vitest runs only after every `unit` file has finished.
// Neither depends on timing or on the order files happen to be scheduled in.
//
// Consequence: this test needs the whole `unit` project to have run in the same
// invocation. `vitest run` and `npm test` do that; running this file alone
// finds nothing recorded and says so, rather than passing on an empty set.
//
// WHICH TESTS COUNT. Only tests under src/engine/, and not the ones listed in
// META_TESTS: those call `runPipeline` to test the linter, the registry or this
// table itself, and a directive that only they run is not simulated by
// anything they show. Nothing under PRIVATE_DIR counts either (see above).
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { DIRECTIVE_SUPPORT } from '../directiveSupport';

interface Fs {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface Recording {
  testFile: string;
  keys: string[];
}

/**
 * Test files whose `runPipeline` calls are about something other than a
 * directive's behaviour, so what they feed it is not evidence.
 */
const META_TESTS: Record<string, string> = {
  'src/engine/__tests__/directiveLint.test.ts': "asserts the linter's diagnostics, not the pipeline's output",
  'src/engine/__tests__/directiveSupport.test.ts':
    'asserts the "not simulated" diagnostics; borrows real keys as stand-ins',
  'src/engine/__tests__/directiveValues.test.ts': 'asserts which values validate, not what the engine does with them',
  'src/engine/__tests__/prototypeDirectiveNames.test.ts': 'feeds Object.prototype names as directive keys',
  'src/engine/__tests__/directiveRegistry.test.ts': 'asserts registry metadata',
};

/** Git-ignored local-only tests; never part of the repository. */
const PRIVATE_DIR = 'src/engine/__tests__/private/';

/**
 * Simulated directives that are exercised and have no documentation-citing
 * test. Each is a claim resting on a test that says nothing about
 * where its expectation came from. Fix an entry by adding the citation (see
 * `isCitedIn`) or by reclassifying the directive `documented`, and delete it
 * here. The list may not grow: DOC_UNCITED_CEILING is its length today.
 *
 * MUST_NOT_BREAK_BEFORE is simulated as having no effect, which is observed
 * behaviour rather than what props.conf.spec describes, so no test written from
 * the documentation can assert it (directiveSupport.ts has the note).
 */
const DOC_UNCITED: string[] = ['MUST_NOT_BREAK_BEFORE'];
const DOC_UNCITED_CEILING = 1;

// ---- Inputs ----------------------------------------------------------------

/** Every engine test source, as text, keyed by repository path. */
const ENGINE_TEST_SOURCES = new Map(
  Object.entries(import.meta.glob<string>('../**/*.test.ts', { eager: true, query: '?raw', import: 'default' })).map(
    ([path, text]) => [path.replace(/^\.\//, 'src/engine/__tests__/').replace(/^\.\.\//, 'src/engine/'), text],
  ),
);

function readRecordings(): Recording[] {
  const proc = (
    globalThis as unknown as {
      process: { env: Record<string, string | undefined>; getBuiltinModule: (id: 'node:fs') => Fs };
    }
  ).process;
  const dir = proc.env['PROPSLAB_EVIDENCE_DIR'];
  const fs = proc.getBuiltinModule('node:fs');
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8')) as Recording);
}

/**
 * Whether `testFile` carries a citation for `key`: one comment block that says
 * "doc-derived", names a .spec file, and names the directive. The file is the
 * unit because that is what the recording knows; a comment for one test in a
 * file whose other tests run the directive is close enough to be worth having.
 */
function isCitedIn(testFile: string, key: string): boolean {
  const source = ENGINE_TEST_SOURCES.get(testFile) ?? '';
  const named = new RegExp(`(?<![A-Za-z0-9_])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
  const blocks = source.match(/\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/.*(?:\n|$))+/gm) ?? [];
  return blocks.some(
    (block) => /doc-derived/i.test(block) && /\b(?:props|transforms)\.conf\.spec\b/.test(block) && named.test(block),
  );
}

// ---- Classification ---------------------------------------------------------

const simulated = Object.entries(DIRECTIVE_SUPPORT)
  .filter(([, e]) => e.support === 'simulated')
  .map(([key]) => key);

const recordings = readRecordings();
const counted = recordings.filter(
  (r) => r.testFile.startsWith('src/engine/') && !r.testFile.startsWith(PRIVATE_DIR) && !(r.testFile in META_TESTS),
);

/** key -> test files that ran it through the pipeline. */
const exercisedBy = new Map<string, string[]>();
for (const r of counted) {
  for (const key of r.keys) exercisedBy.set(key, [...(exercisedBy.get(key) ?? []), r.testFile]);
}

const cited = new Set(simulated.filter((key) => (exercisedBy.get(key) ?? []).some((file) => isCitedIn(file, key))));

describe('simulated directive evidence (#505)', () => {
  it('has the recordings it reads', () => {
    // Guards the reader, not the engine. An empty set here would make every
    // check below vacuous or every directive "unexercised"; either way the
    // cause is that the `unit` project did not run first in this invocation.
    expect(
      recordings.length,
      'nothing was recorded: run the whole suite (`npm test`), not this file alone -- ' +
        'src/test/recordDirectiveEvidence.ts records while the `unit` project runs',
    ).toBeGreaterThan(0);
    expect(
      counted.map((r) => r.testFile),
      'docDerivedDirectives.test.ts must be among the recordings, or the recorder is not seeing runPipeline',
    ).toContain('src/engine/__tests__/docDerivedDirectives.test.ts');
  });

  it('runs every simulated directive through the pipeline in at least one test', () => {
    const unexercised = simulated.filter((key) => !exercisedBy.has(key));
    expect(
      unexercised,
      'declared simulated, but no engine test passes them to runPipeline: either they are not really ' +
        'simulated -- reclassify them in directiveSupport.ts -- or the behaviour is unasserted',
    ).toEqual([]);
  });

  it('backs every simulated directive with a test that cites the documentation', () => {
    const uncited = simulated.filter((key) => !cited.has(key));
    const unlisted = uncited.filter((key) => !DOC_UNCITED.includes(key));
    expect(
      unlisted,
      'no test that runs these has a comment citing the spec. Either add one -- ' +
        'a comment block with "Doc-derived", the .spec file (props.conf.spec / transforms.conf.spec) and the ' +
        'directive name, beside a test that asserts the documented behaviour -- or reclassify the directive ' +
        '`documented` in directiveSupport.ts. Adding it to DOC_UNCITED is not the answer: that list only shrinks.',
    ).toEqual([]);
  });

  it('keeps DOC_UNCITED to directives that still lack a citation', () => {
    const stale = DOC_UNCITED.filter((key) => cited.has(key) || !simulated.includes(key));
    expect(stale, 'these now have a citation, or are no longer simulated -- delete them from DOC_UNCITED').toEqual([]);
  });

  it('does not grow DOC_UNCITED', () => {
    expect(DOC_UNCITED.length).toBeLessThanOrEqual(DOC_UNCITED_CEILING);
  });

  it('evidence classification summary', () => {
    const only = (pred: (key: string) => boolean) => simulated.filter(pred);
    const summary = [
      'Simulated directive evidence:',
      `  - Doc-cited test: ${only((k) => cited.has(k)).length}`,
      `  - Exercised only: ${only((k) => !cited.has(k) && exercisedBy.has(k)).length}`,
      `  - Total: ${simulated.length}`,
    ].join('\n');

    if (import.meta.env['SHOW_EVIDENCE']) {
      // eslint-disable-next-line no-console
      console.info(summary);
    }
    expect(
      only((k) => cited.has(k) || exercisedBy.has(k)).length + only((k) => !cited.has(k) && !exercisedBy.has(k)).length,
    ).toBe(simulated.length);
  });
});
