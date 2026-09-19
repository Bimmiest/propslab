// ---------------------------------------------------------------------------
// directiveSupport.test.ts
// Guards the declared simulation boundary (#153).
//
// A classification table is only worth having if it cannot drift from the code
// it describes. Three things are asserted here: every registry key is
// classified, every non-simulated key explains itself, and every `simulated`
// key is actually exercised by a test. The third is the one with teeth --
// without it, "simulated" degrades into "we meant to".
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { getAllDirectives } from '../directiveRegistry';
import { DIRECTIVE_SUPPORT, UNDOCUMENTED_ATTRIBUTES } from '../directiveSupport';
import type { SupportEntry } from '../directiveSupport';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

const SELF = 'directiveSupport.test.ts';

/**
 * Every test source in the repo, as text. Read through Vite's raw glob so the
 * suite needs no filesystem access and runs wherever the engine runs.
 */
const TEST_SOURCES = Object.entries(
  import.meta.glob<string>('../../**/*.test.{ts,tsx}', { eager: true, query: '?raw', import: 'default' }),
).filter(([path]) => !path.endsWith(SELF));

/** The corpus is ground truth from Splunk, so count it too. */
const CORPUS_SOURCE = Object.values(
  import.meta.glob<string>('../__tests__/fixtures/corpus.ts', {
    eager: true,
    query: '?raw',
    import: 'default',
  }),
);

const ALL_TEST_TEXT = [...TEST_SOURCES.map(([, text]) => text), ...CORPUS_SOURCE].join('\n');

describe('directive support classification (#153)', () => {
  it('classifies every directive in the registry', () => {
    const unclassified = getAllDirectives()
      .filter((d) => !(d.key in DIRECTIVE_SUPPORT))
      .map((d) => d.key);
    expect(
      unclassified,
      'a directive was added to the registry without deciding whether it is simulated, ' +
        'documented or ignored -- add it to DIRECTIVE_SUPPORT',
    ).toEqual([]);
  });

  it('classifies nothing that is not in the registry', () => {
    const keys = new Set(getAllDirectives().map((d) => d.key));
    const orphans = Object.keys(DIRECTIVE_SUPPORT).filter((k) => !keys.has(k));
    expect(orphans, 'classified keys that no longer exist in the registry').toEqual([]);
  });

  it('gives every non-simulated directive a reason', () => {
    const silent = Object.entries(DIRECTIVE_SUPPORT)
      .filter(([, e]) => e.support !== 'simulated' && !e.note)
      .map(([k]) => k);
    expect(silent, 'a directive is declared unsupported without saying why').toEqual([]);
  });

  it('gives every ignored directive a tracking issue', () => {
    const untracked = Object.entries(DIRECTIVE_SUPPORT)
      .filter(([, e]) => e.support === 'ignored' && e.issue === undefined)
      .map(([k]) => k);
    expect(
      untracked,
      'an `ignored` directive is a known wrong answer, so it needs an issue or it will not be fixed',
    ).toEqual([]);
  });

  it('exercises every simulated directive in at least one test', () => {
    const untested = Object.entries(DIRECTIVE_SUPPORT)
      .filter(([, e]) => e.support === 'simulated')
      .map(([key]) => key)
      // Class-based keys appear as `EXTRACT-name` in a conf body, so match the
      // bare prefix rather than requiring the exact registry key.
      .filter((key) => !ALL_TEST_TEXT.includes(key));
    expect(
      untested,
      'these are declared simulated but no test mentions them -- either they are not really ' +
        'simulated, or the behaviour is unasserted, and both are the same problem for a simulator',
    ).toEqual([]);
  });

  it('keeps the README counts in step with the table', () => {
    // The README states the three counts as plain numbers. A stated number that
    // silently goes stale is worse than no number, so it is asserted rather
    // than trusted -- this is what makes the README's claim maintainable.
    const readme = Object.values(
      import.meta.glob<string>('../../../README.md', { eager: true, query: '?raw', import: 'default' }),
    )[0];
    expect(readme, 'README.md could not be read').toBeTruthy();

    const counts = { simulated: 0, documented: 0, ignored: 0 };
    for (const entry of Object.values(DIRECTIVE_SUPPORT)) counts[entry.support]++;

    for (const [level, count] of Object.entries(counts)) {
      const row = new RegExp(`\\*\\*${level}\\*\\*\\s*\\|\\s*(\\d+)\\s*\\|`).exec(readme ?? '');
      expect(row, `README has no support-table row for "${level}"`).toBeTruthy();
      expect(Number(row?.[1]), `README says ${row?.[1]} ${level} directives; the table has ${count}`).toBe(
        count,
      );
    }
  });

  it('lists nothing as undocumented that the registry has since documented', () => {
    // This is the drift that #178's own issue body suffered: it named 32
    // missing attributes, three of which #176 added before anyone acted on it.
    // A list of "things we do not know about" is worth exactly as much as its
    // freshness, so it is asserted rather than trusted.
    const keys = new Set(getAllDirectives().map((d) => d.key));
    const documented = [...UNDOCUMENTED_ATTRIBUTES].filter((k) => keys.has(k));
    expect(
      documented,
      'these are in the registry now -- remove them from UNDOCUMENTED_ATTRIBUTES',
    ).toEqual([]);
  });

  it('keeps the undocumented list disjoint from the classification table', () => {
    const both = [...UNDOCUMENTED_ATTRIBUTES].filter((k) => k in DIRECTIVE_SUPPORT);
    expect(both, 'a key cannot be both classified and unknown to us').toEqual([]);
  });

  it('keeps the README undocumented count in step with the list', () => {
    const readme = Object.values(
      import.meta.glob<string>('../../../README.md', { eager: true, query: '?raw', import: 'default' }),
    )[0];
    const stated = /\*\*(\d+)\*\* attributes are valid in Splunk/.exec(readme ?? '');
    expect(stated, 'README has no undocumented-attribute count').toBeTruthy();
    expect(Number(stated?.[1])).toBe(UNDOCUMENTED_ATTRIBUTES.size);
  });

  it('never marks a directive simulated without the engine reading it', () => {
    // A cheap direction check on the two the registry defines per conf file:
    // both are `documented`, so neither should ever be claimed as simulated.
    expect(DIRECTIVE_SUPPORT['MATCH_LIMIT']?.support).toBe('documented');
    expect(DIRECTIVE_SUPPORT['DEPTH_LIMIT']?.support).toBe('documented');
  });
});

const metadata: EventMetadata = {
  index: 'main',
  host: 'h',
  source: 's',
  sourcetype: 'st',
};

function diagnosticsFor(props: string, transforms = '') {
  return runPipeline('2026-01-15T10:00:00Z hello\n', metadata, `[st]\n${props}`, transforms, {
    perEventPipeline: false,
    captureOffsets: false,
  }).diagnostics;
}

/**
 * Run `body` with one registry key temporarily reclassified, then put the table
 * back.
 *
 * The `ignored` warning has to stay assertable when nothing is ignored. These
 * tests used to borrow whichever directive happened to be unimplemented —
 * `TZ_ALIAS`, until #227 implemented it and emptied the roster — and a test
 * written that way fails the day the borrowed directive is fixed, which is the
 * wrong signal from a good event. A synthetic entry asserts the mechanism
 * instead of the roster, so the two stop being coupled.
 */
function withSupport<T>(key: string, entry: SupportEntry, body: () => T): T {
  const original = DIRECTIVE_SUPPORT[key];
  DIRECTIVE_SUPPORT[key] = entry;
  try {
    return body();
  } finally {
    if (original === undefined) delete DIRECTIVE_SUPPORT[key];
    else DIRECTIVE_SUPPORT[key] = original;
  }
}

/** A stand-in classification. The key is real so the registry knows it; the
 *  support level is not, so the roster can be empty and this still runs. */
const IGNORED_STANDIN: SupportEntry = {
  support: 'ignored',
  issue: 9999,
  note: 'Stand-in used to assert the ignored-directive warning.',
};

/**
 * Run `body` with one key temporarily treated as an undocumented attribute.
 *
 * `UNDOCUMENTED_ATTRIBUTES` is typed readonly but is a Set underneath, which is
 * what lets this put a name in and take it out again. The alternative -- naming
 * whichever attribute happens to be unregistered today -- is the shape that
 * broke when #178 registered them all.
 */
function withUndocumented<T>(key: string, body: () => T): T {
  const set = UNDOCUMENTED_ATTRIBUTES as Set<string>;
  const had = set.has(key);
  set.add(key);
  try {
    return body();
  } finally {
    if (!had) set.delete(key);
  }
}

describe('unsimulated directives are reported rather than ignored (#153)', () => {
  it('warns, and names the tracking issue, for an ignored directive', () => {
    const d = withSupport('TZ_ALIAS', IGNORED_STANDIN, () =>
      diagnosticsFor('TZ_ALIAS = EST=GMT-5\n').find((x) => x.directiveKey === 'TZ_ALIAS'),
    );
    expect(d?.level).toBe('warning');
    expect(d?.message).toContain('not simulated');
    expect(d?.message).toContain('#9999');
  });

  it('informs, without an issue, for a directive that is out of scope on purpose', () => {
    const d = diagnosticsFor('CHARSET = UTF-16\n').find((x) => x.directiveKey === 'CHARSET');
    expect(d?.level).toBe('info');
    expect(d?.message).toContain('already decoded');
    expect(d?.message).not.toContain('#');
  });

  it('locates the diagnostic on the line the directive is written on', () => {
    // Line 1 is the stanza header, so TRUNCATE is 2 and TZ_ALIAS is 3.
    const d = withSupport('TZ_ALIAS', IGNORED_STANDIN, () =>
      diagnosticsFor('TRUNCATE = 500\nTZ_ALIAS = EST=GMT-5\n').find(
        (x) => x.directiveKey === 'TZ_ALIAS',
      ),
    );
    expect(d?.line).toBe(3);
    expect(d?.file).toBe('props.conf');
  });

  it('says nothing about a directive that is simulated', () => {
    const keys = diagnosticsFor('TRUNCATE = 500\nKV_MODE = auto\n')
      .filter((d) => d.message.includes('not simulated'))
      .map((d) => d.directiveKey);
    expect(keys).toEqual([]);
  });

  it('reports transforms.conf attributes against the transforms editor', () => {
    // `external_cmd` is `documented` rather than `ignored`, so this also pins
    // the informational level for a deliberate, permanent edge.
    const d = diagnosticsFor(
      'TRANSFORMS-x = t1\n',
      '[t1]\nREGEX = (?<a>\\w+)\nWRITE_META = true\nexternal_cmd = lookup.py\n',
    ).find((x) => x.directiveKey === 'external_cmd');
    expect(d?.file).toBe('transforms.conf');
    expect(d?.level).toBe('info');
    expect(d?.message).toContain('not simulated');
  });

  it('warns for a valid attribute the registry does not document (#178)', () => {
    // #178 emptied UNDOCUMENTED_ATTRIBUTES, so this borrows a name the way the
    // ignored-directive tests above borrow a classification: the mechanism has
    // to stay assertable when there is nothing currently parked in it, or it
    // quietly stops being tested the moment the roster is clean.
    // A name the registry will never hold, so this cannot break again the way
    // it did when #178 registered the real attribute it used to borrow.
    const KEY = 'A_FUTURE_SPLUNK_ATTRIBUTE';
    const d = withUndocumented(KEY, () =>
      diagnosticsFor(`${KEY} = foo\n`).find((x) => x.directiveKey === KEY),
    );
    expect(d?.level).toBe('warning');
    expect(d?.message).toContain('valid Splunk attribute');
    // Deliberately asserts no issue number: the message used to name #178,
    // which has closed. Pointing a user at a finished issue is the rot #227
    // was about.
    expect(d?.message).not.toContain('#178');
  });

  it('still says nothing about a key that is genuinely not an attribute', () => {
    // The undocumented list must not turn into a catch-all that mutes the typo
    // diagnostic, which is the only thing that catches a misspelling.
    const d = diagnosticsFor('NOT_A_REAL_DIRECTIVE = 1\n').find(
      (x) => x.directiveKey === 'NOT_A_REAL_DIRECTIVE',
    );
    expect(d).toBeUndefined();
  });

  it('does not double-report LOOKUP, which has its own warning', () => {
    const lookupDiags = diagnosticsFor('LOOKUP-geo = geo_lookup ip OUTPUT city\n').filter(
      (d) => d.directiveKey?.startsWith('LOOKUP'),
    );
    expect(lookupDiags).toHaveLength(1);
    expect(lookupDiags[0]?.message).toContain('lookup table execution is not simulated');
  });
});
