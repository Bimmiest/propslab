// ---------------------------------------------------------------------------
// directiveEvidence.test.ts
// Classifies each simulated directive by its evidence source.
//
// A directive declared simulated but without proper evidence is the same as
// undeclared support: it fails silently. This test ensures coverage of the
// simulated surface is documented and pinned.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { DIRECTIVE_SUPPORT } from '../directiveSupport';

interface FixtureWithDirectives {
  directives?: string[];
}

/**
 * All fixture JSON files across all versions, loaded through Vite's glob.
 * Each fixture names the directives it exercises.
 */
const FIXTURE_MODULES = import.meta.glob<{ default: FixtureWithDirectives }>(
  './fixtures/splunk-*/*.json',
  { eager: true }
);

/**
 * Every test source in the repo, loaded as text.
 */
const TEST_SOURCES = Object.entries(
  import.meta.glob<string>('../../**/*.test.{ts,tsx}', { eager: true, query: '?raw', import: 'default' }),
).map(([, text]) => text);

const ALL_TEST_TEXT = TEST_SOURCES.join('\n');

/**
 * Check if a directive key is exercised in test source code.
 * Matches multiple patterns:
 * - Conf text: KEY = value or KEY-subname = value
 * - Object literals: KEY: / 'KEY': / "KEY":
 * - Function arguments: ('KEY' or ("KEY" as first argument
 * Excludes pure prose mentions (need to match one of these specific patterns).
 */
function isDocumentedInTest(key: string): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Pattern 1: Conf text - KEY = value or KEY-subname = value
  const confPattern = new RegExp(
    `(^|[\\n"'` + '`' + `\\\\n])\\s*${escapedKey}(-[A-Za-z0-9_]+)?\\s*=`,
    'm'
  );
  if (confPattern.test(ALL_TEST_TEXT)) return true;

  // Pattern 2: Object literal keys - KEY: or 'KEY': or "KEY":
  const objectKeyPattern = new RegExp(
    `[{\\n\\s]${escapedKey}\\s*:|[{\\n\\s]['"]${escapedKey}['"]\\s*:`,
    'm'
  );
  if (objectKeyPattern.test(ALL_TEST_TEXT)) return true;

  // Pattern 3: Function arguments - ('KEY' or ("KEY"
  const funcArgPattern = new RegExp(
    `\\(\\s*['"]${escapedKey}['"]`,
    'm'
  );
  if (funcArgPattern.test(ALL_TEST_TEXT)) return true;

  return false;
}

describe('simulated directive evidence (#505)', () => {
  const simulatedDirectives = Object.entries(DIRECTIVE_SUPPORT)
    .filter(([, e]) => e.support === 'simulated')
    .map(([key]) => key);

  // Classify each simulated directive
  const fixtureBackedSet = new Set<string>();
  const documentedTestSet = new Set<string>();
  const noneSet = new Set<string>();

  // Collect fixture-backed directives
  for (const [path, mod] of Object.entries(FIXTURE_MODULES)) {
    if (path.endsWith('/manifest.json')) continue;
    const fixture = mod.default;
    if (fixture.directives) {
      for (const directive of fixture.directives) {
        // Normalize: strip trailing dash from class-based directives
        const key = directive.endsWith('-') ? directive.slice(0, -1) : directive;
        if (simulatedDirectives.includes(key)) {
          fixtureBackedSet.add(key);
        }
      }
    }
  }

  // Classify remaining directives
  for (const key of simulatedDirectives) {
    if (fixtureBackedSet.has(key)) {
      continue; // Already classified as fixture-backed
    }
    if (isDocumentedInTest(key)) {
      documentedTestSet.add(key);
    } else {
      noneSet.add(key);
    }
  }

  it('every simulated directive has evidence', () => {
    // All directives should have evidence through fixtures or documented tests
    const missingEvidence = [...noneSet];
    expect(
      missingEvidence,
      'these directives are declared simulated but have no fixture or test exercise'
    ).toEqual([]);
  });

  // Pin the fixture-backed count with a ratchet; it should only grow as fixtures are added
  it('fixture-backed directive count does not regress', () => {
    // When a new fixture is added, update this number and add a comment saying which fixture(s)
    // When a fixture is updated to exercise more directives, note it here
    // Current count: 44 fixtures covering 44 simulated directives
    expect(fixtureBackedSet.size).toBeGreaterThanOrEqual(44);
  });

  // Print evidence counts for debugging (guarded by environment variable check)
  it('evidence classification summary', () => {
    const summary = `
Simulated directive evidence:
  - Fixture-backed: ${fixtureBackedSet.size}
  - Documented in test: ${documentedTestSet.size}
  - No evidence: ${noneSet.size}
  - Total: ${simulatedDirectives.length}
    `.trim();

    if (import.meta.env.SHOW_EVIDENCE) {
      // eslint-disable-next-line no-console
      console.info(summary);
    }

    expect(fixtureBackedSet.size + documentedTestSet.size + noneSet.size).toBe(
      simulatedDirectives.length
    );
  });
});
