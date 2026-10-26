// ---------------------------------------------------------------------------
// directiveEvidence.test.ts
// What backs each directive that DIRECTIVE_SUPPORT calls `simulated`.
//
// A `simulated` directive is a claim that the engine reproduces Splunk. Two
// things can stand behind it, stronger first:
//
//   cited     a test that really runs it through the pipeline, under a comment
//             that says the expectation was derived from the spec ("Doc-derived",
//             the .spec file, and the directive's name in one comment), placed
//             above that test, above a describe it is in, or at the top of its
//             file (#569). A comment above another test in the file does not count.
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
// invocation. `vitest run` and `npm test` do that. vitest.config.ts records only
// for such a full run (and always on CI); on any other run, this file alone or
// a shard, nothing is recorded and this test skips (#569).
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
  /** Test name ("describe > it", as vitest names it) -> the keys that test ran. */
  tests: Record<string, string[]>;
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
 * `isCitedFor`) or by reclassifying the directive `documented`, and delete it
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

const proc = (
  globalThis as unknown as {
    process: { env: Record<string, string | undefined>; getBuiltinModule: (id: 'node:fs') => Fs };
  }
).process;
/** Set by vitest.config.ts for a full run only. */
const recording = proc.env['PROPSLAB_EVIDENCE_DIR'] !== undefined;

function readRecordings(): Recording[] {
  const dir = proc.env['PROPSLAB_EVIDENCE_DIR'];
  const fs = proc.getBuiltinModule('node:fs');
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8')) as Recording);
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
/** A comment line at the left margin: a section banner, outside every describe. */
const TOP_LEVEL_COMMENT = /^(?:\/\/|\/\*|\s\*)/;

/** The comment lines directly above line `index` of `lines`, as one block. */
function commentAbove(lines: string[], index: number): string {
  let start = index;
  while (start > 0 && COMMENT.test(lines[start - 1] ?? '')) start--;
  return lines.slice(start, index).join('\n');
}

/** The comment lines directly below line `index`: the first lines of a describe's or a test's body. */
function commentBelow(lines: string[], index: number): string {
  let end = index + 1;
  while (end < lines.length && COMMENT.test(lines[end] ?? '')) end++;
  return lines.slice(index + 1, end).join('\n');
}

/** The nearest section banner above line `index`: a block of comment lines at the left margin. */
function sectionAbove(lines: string[], index: number): string {
  let end = index;
  while (end > 0 && !TOP_LEVEL_COMMENT.test(lines[end - 1] ?? '')) end--;
  let start = end;
  while (start > 0 && TOP_LEVEL_COMMENT.test(lines[start - 1] ?? '')) start--;
  return lines.slice(start, end).join('\n');
}

/**
 * The comment blocks that speak for `testName` in `source`, for each describe
 * and the test in its name (found by their literal titles): the block directly
 * above the call, the block that opens its body, and the section banner above
 * it; and the file's own header. A title built at run time (a template,
 * `it.each`) is not found, so a citation for such a test goes on its describe.
 */
function commentsFor(source: string, testName: string): string[] {
  const lines = source.split('\n');
  const header = lines
    .slice(
      0,
      lines.findIndex((l) => !/^\s*(?:\/\/|\/\*|\*|$)/.test(l)),
    )
    .join('\n');
  const blocks = [header];
  for (const title of testName.split(' > ')) {
    const call = new RegExp(`^\\s*(?:describe|it|test)(?:\\.\\w+)*\\(\\s*(['"\`])${escapeRegex(title)}\\1`);
    lines.forEach((line, i) => {
      if (call.test(line)) blocks.push(commentAbove(lines, i), commentBelow(lines, i), sectionAbove(lines, i));
    });
  }
  return blocks;
}

/**
 * Whether `testName` in `testFile` is cited for `key`: one comment block that
 * speaks for it says "doc-derived", names a .spec file, and names the
 * directive.
 */
function isCitedFor(testFile: string, testName: string, key: string): boolean {
  const named = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(key)}(?![A-Za-z0-9_])`);
  return commentsFor(ENGINE_TEST_SOURCES.get(testFile) ?? '', testName).some(
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

const cited = new Set(
  simulated.filter((key) =>
    counted.some((r) =>
      Object.entries(r.tests).some(([testName, keys]) => keys.includes(key) && isCitedFor(r.testFile, testName, key)),
    ),
  ),
);

describe.skipIf(!recording)('simulated directive evidence (#505)', () => {
  it('has the recordings it reads', () => {
    // Guards the reader, not the engine. An empty set here would make every
    // check below vacuous or every directive "unexercised"; either way the
    // cause is that the `unit` project did not run first in this invocation.
    // A partial run records nothing and skips this file, so this fires only
    // when a full run (or CI) recorded nothing at all.
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

  it('has no engine test that mocks the pipeline, which would hide its runs from the recorder (#569)', () => {
    const mocking = [...ENGINE_TEST_SOURCES]
      .filter(([, source]) => /vi\.(?:do)?[mM]ock\(\s*['"][./]*(?:[\w./]*\/)?pipeline['"]/.test(source))
      .map(([file]) => file);
    expect(mocking, 'these mock the pipeline, so nothing they run is recorded as evidence').toEqual([]);
  });

  it('keeps DOC_UNCITED to directives that still lack a citation', () => {
    const stale = DOC_UNCITED.filter((key) => cited.has(key) || !simulated.includes(key));
    expect(stale, 'these now have a citation, or are no longer simulated -- delete them from DOC_UNCITED').toEqual([]);
  });

  it('does not grow DOC_UNCITED', () => {
    expect(DOC_UNCITED.length).toBeLessThanOrEqual(DOC_UNCITED_CEILING);
  });
});
