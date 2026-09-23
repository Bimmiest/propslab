// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// splunkFidelity.test.ts
// Replays the fidelity corpus through the engine and asserts it reproduces
// output captured from a real Splunk instance.
//
// Every other engine test asserts the simulator against our reading of the
// docs, which cannot catch a misreading shared by the implementation and the
// test. These fixtures are the only assertions here derived from Splunk itself.
//
// Hermetic: reads committed JSON, never contacts Splunk. There is no capture
// tooling and no further capture is planned; fixtures/README.md says why.
//
// Runs under jsdom rather than the engine default of `node`, because the engine
// is a *browser* target and parts of it reach for browser APIs: `KV_MODE = xml`
// calls `DOMParser`, which does not exist in Node. Under `node` that path threw,
// was swallowed by its own try/catch, and extracted nothing -- so the fixture
// recorded a divergence that the shipped app does not have. A fidelity suite
// that cannot run a directive is worse than one that skips it, since the empty
// result reads as a finding.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runPipeline } from '../pipeline';
import { getDirectiveInfo } from '../directiveRegistry';
import { CORPUS, type FixtureCase } from './fixtures/corpus';
import type { EventMetadata } from '../types';

interface CapturedEvent {
  _raw: string;
  _time: number | null;
  fields: Record<string, string | string[]>;
}

interface Fixture {
  id: string;
  splunk: { version: string; build: string };
  capturedAt: string;
  phase: FixtureCase['phase'];
  comparePunct?: boolean;
  props: string;
  transforms?: string;
  extraProps?: Array<{ stanza: string; body: string }>;
  ingestHost?: string;
  ingestSource?: string;
  input: string;
  events: CapturedEvent[];
}

/**
 * Loaded through Vite's glob rather than `node:fs` so the suite carries no
 * Node-only imports and needs no filesystem access at run time.
 */
const FIXTURE_MODULES = import.meta.glob<{ default: Fixture }>('./fixtures/splunk-*/*.json', {
  eager: true,
});

/** Every captured version directory. More than one is fine; each is asserted. */
function fixtureSets(): Array<{ version: string; fixtures: Fixture[] }> {
  const byVersion = new Map<string, Fixture[]>();
  for (const [path, mod] of Object.entries(FIXTURE_MODULES)) {
    if (path.endsWith('/manifest.json')) continue;
    const version = /\/splunk-([^/]+)\//.exec(path)?.[1];
    if (!version) continue;
    const list = byVersion.get(version) ?? [];
    list.push(mod.default);
    byVersion.set(version, list);
  }
  return [...byVersion.entries()].map(([version, fixtures]) => ({ version, fixtures }));
}

/**
 * The engine is handed the same stanza the capture wrote, minus the run scoping
 * -- capture uses `fx_<run>_<id>` so that re-runs cannot collide inside one
 * Splunk instance, which is irrelevant here.
 */
function runCase(fixture: Fixture, injectNow = true): ReturnType<typeof runPipeline> {
  const sourcetype = `fx_${fixture.id.replace(/-/g, '_')}`;
  const metadata: EventMetadata = {
    index: 'fixtures',
    host: fixture.ingestHost ?? 'fixture-capture',
    source: fixture.ingestSource ?? 'fixture-capture',
    sourcetype,
  };
  // Extra stanzas come first so their position in the file cannot be what
  // decides precedence -- Splunk resolves by specificity, not by file order,
  // and a corpus that agreed only because of ordering would prove nothing.
  const extra = (fixture.extraProps ?? []).map((e) => `[${e.stanza}]\n${e.body}`).join('\n');
  const props = `${extra}\n[${sourcetype}]\n${fixture.props}`;
  // `now` is the capture instant, not the wall clock. The captured `_time`s
  // were judged by Splunk against the day of capture — MAX_DAYS_AGO counts back
  // from it, and a yearless format takes its year — so replaying them against
  // today would let the suite go red by the calendar alone, a divergence that
  // says nothing about the engine (#293).
  return runPipeline(fixture.input, metadata, props, fixture.transforms ?? '', {
    perEventPipeline: false,
    captureOffsets: false,
    ...(injectNow ? { now: Date.parse(fixture.capturedAt) } : {}),
  });
}

/** Engine output reduced to the shape the fixture records. */
function engineEvents(fixture: Fixture, injectNow = true): CapturedEvent[] {
  const { result } = runCase(fixture, injectNow);
  return result.events.map((e) => {
    // The capture excluded `punct` from every fixture unless the case opted
    // back in with `comparePunct` — the punct-signature cases do, and for them
    // the engine's punct is compared like any other field.
    const { punct: _punct, ...withoutPunct } = e.fields;
    return {
      _raw: e._raw,
      _time: e._time ? e._time.getTime() : null,
      fields: fixture.comparePunct ? e.fields : withoutPunct,
    };
  });
}

/** Human-readable diff summary; `expect` alone buries which event diverged. */
function describeDivergence(actual: CapturedEvent[], expected: CapturedEvent[]): string {
  const lines: string[] = [];
  if (actual.length !== expected.length) {
    lines.push(`event count: engine ${actual.length}, Splunk ${expected.length}`);
  }
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    const a = actual[i];
    const b = expected[i];
    if (!a) { lines.push(`[${i}] missing from engine output (Splunk: ${JSON.stringify(b?._raw)})`); continue; }
    if (!b) { lines.push(`[${i}] extra in engine output (${JSON.stringify(a._raw)})`); continue; }
    if (a._raw !== b._raw) lines.push(`[${i}] _raw:\n    engine: ${JSON.stringify(a._raw)}\n    splunk: ${JSON.stringify(b._raw)}`);
    if (a._time !== b._time) lines.push(`[${i}] _time: engine ${a._time}, splunk ${b._time}`);
    const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
    for (const k of keys) {
      const av = JSON.stringify(a.fields[k]);
      const bv = JSON.stringify(b.fields[k]);
      if (av !== bv) lines.push(`[${i}] field ${k}: engine ${av ?? '(absent)'}, splunk ${bv ?? '(absent)'}`);
    }
  }
  return lines.join('\n');
}

const sets = fixtureSets();

describe.skipIf(sets.length === 0)('Splunk fidelity fixtures', () => {
  for (const { version, fixtures } of sets) {
    describe(`Splunk ${version}`, () => {
      it('every fixture has a corpus case', () => {
        const ids = new Set(CORPUS.map((c) => c.id));
        const orphans = fixtures.filter((f) => !ids.has(f.id)).map((f) => f.id);
        expect(orphans, 'fixtures with no corpus case -- a case was renamed or removed').toEqual([]);
      });

      it('every corpus case has a fixture', () => {
        const captured = new Set(fixtures.map((f) => f.id));
        const missing = CORPUS.filter((c) => !captured.has(c.id)).map((c) => c.id);
        expect(missing, 'corpus cases with no fixture -- the corpus is closed to new cases; see fixtures/README.md').toEqual([]);
      });

      for (const fixture of fixtures) {
        const testCase = CORPUS.find((c) => c.id === fixture.id);

        // A case the engine is known to get wrong is inverted rather than
        // skipped: it fails once the engine starts matching, which is the
        // prompt to delete `knownMismatch` and let the real assertion stand.
        if (testCase?.knownMismatch) {
          it(`${fixture.id} — still diverges (${testCase.knownMismatch})`, () => {
            const divergence = describeDivergence(engineEvents(fixture), fixture.events);
            expect(
              divergence,
              `engine now matches Splunk for "${fixture.id}". Remove knownMismatch ` +
                `(${testCase.knownMismatch}) from the corpus so this is asserted properly.`
            ).not.toBe('');
          });
          continue;
        }

        it(`${fixture.id} — matches Splunk ${version}`, () => {
          const actual = engineEvents(fixture);
          const divergence = describeDivergence(actual, fixture.events);
          expect(divergence, `\n${divergence}\n`).toBe('');
        });
      }
    });
  }
});

describe('fidelity corpus', () => {
  it('every case id is unique', () => {
    const ids = CORPUS.map((c) => c.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it('every named directive exists in the registry', () => {
    const unknown: string[] = [];
    for (const c of CORPUS) {
      for (const key of c.directives) {
        // Class-based directives are named by their bare prefix in the corpus
        // ("EXTRACT-"), which the registry cannot resolve -- it requires a
        // non-empty class name. Strip the trailing dash and look up the base.
        const lookup = key.endsWith('-') ? key.slice(0, -1) : key;
        const known =
          getDirectiveInfo(lookup, 'props.conf') ?? getDirectiveInfo(lookup, 'transforms.conf');
        if (!known) unknown.push(`${c.id}: ${key}`);
      }
    }
    expect(unknown, 'corpus references directives absent from directiveRegistry.ts').toEqual([]);
  });

  it('every transforms stanza name is unique corpus-wide', () => {
    const names: string[] = [];
    for (const c of CORPUS) {
      for (const m of (c.transforms ?? '').matchAll(/^\[(.+)\]$/gm)) names.push(m[1]!);
    }
    expect(names, 'transforms stanzas share one namespace at capture time').toHaveLength(new Set(names).size);
  });
});

// The fixtures carry absolute timestamps, and MAX_DAYS_AGO (2000 days by
// default) is measured back from "now" — so on the real clock this suite would
// start failing some time around 2031 for no reason but the date (#293). Pin
// the clock far past that and show the capture still matches, and that it is
// the injected `now` doing the work rather than the fixture being immune.
describe('fidelity replay is independent of the wall clock (#293)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const fixture = sets
    .flatMap((s) => s.fixtures)
    .find((f) => f.id === 'timestamp-named-timezone');

  it.skipIf(fixture === undefined)('a capture still matches in 2040 when now is injected', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    const f = fixture!;

    expect(describeDivergence(engineEvents(f), f.events)).toBe('');
    // Control: the same replay against the wall clock rejects the timestamp as
    // older than MAX_DAYS_AGO and falls back to index time.
    expect(describeDivergence(engineEvents(f, false), f.events)).not.toBe('');
  });
});
