// ---------------------------------------------------------------------------
// confParserProperties.test.ts
// Property-based tests for the .conf parser.
//
// A conf is generated as a model — stanzas holding ordered key/value pairs —
// and serialised with everything the file format allows around it: comment and
// blank lines anywhere between logical lines, CRLF or LF per line, whitespace
// around `=` and inside the stanza brackets, trailing whitespace after a
// header, and each value cut by backslash continuations at arbitrary positions.
// Values contain `=`, `#`, `[`, `]` and backslashes of their own.
//
// The serialiser only emits what the model means, so parsing it back must give
// the model. The editor-linter half of the story (the two agree on which lines
// are directives) is in src/monaco/__tests__/diagnosticsParityProperties.test.ts.
//
// The seed is fixed so a run is reproducible.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseConf } from '../parser/confParser';

fc.configureGlobal({ seed: 371, numRuns: 200 });

// ── Model ───────────────────────────────────────────────

interface Pair {
  key: string;
  value: string;
}
interface Stanza {
  /** null: directives before any header, in the implicit [default]. */
  name: string | null;
  pairs: Pair[];
}

const key = fc.constantFrom(
  'TIME_FORMAT', 'LINE_BREAKER', 'SHOULD_LINEMERGE', 'KV_MODE', 'REGEX', 'FORMAT', 'DEST_KEY',
  'EXTRACT-status', 'REPORT-a', 'TRANSFORMS-route', 'SEDCMD-mask', 'EVAL-x', 'FIELDALIAS-a',
  'kv_mode', 'my_custom', 'a.b', 'key with spaces', 'x#y', 'x]',
);

/**
 * A value as the parser stores it: no leading whitespace (the parser consumes
 * whitespace after `=`), no line break, and not ending in an odd run of
 * backslashes, which no serialisation can express — it would continue.
 */
const valueChar = fc.constantFrom('a', 'Z', '0', ' ', '\t', '=', '#', '\\', '[', ']', '%', '(', ')', '"', ';', 'é');
const value = fc
  .array(valueChar, { maxLength: 16 })
  .map((cs) => cs.join(''))
  .filter((v) => !/^\s/.test(v) && trailingBackslashes(v) % 2 === 0);

const stanzaName = fc.constantFrom(
  'default', 'access_log', 'source::/var/log/*.log', 'host::web*', 'my:sourcetype', 'a b', 'x=y', '#hash',
);

const stanza = (name: fc.Arbitrary<string | null>) =>
  fc.record({ name, pairs: fc.array(fc.record({ key, value }), { maxLength: 4 }) });

const model = fc
  .tuple(stanza(fc.constant(null)), fc.array(stanza(stanzaName), { maxLength: 4 }))
  .map(([head, rest]): Stanza[] => [head, ...rest]);

function trailingBackslashes(s: string): number {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === '\\'; i--) n++;
  return n;
}

// ── Serialisation ───────────────────────────────────────

/** Seeds the layout choices of one serialisation. */
const layout = fc.integer();

/** A small deterministic PRNG (mulberry32), seeded by fast-check. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

/**
 * Cut `v` into continuation lines. A cut is allowed only where the text before
 * it ends in an even run of backslashes: the appended `\` must be the odd one
 * that marks a continuation. Any position qualifies otherwise — mid-word,
 * before a space, at 0 (an empty first fragment).
 */
function cut(v: string, rand: () => number): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i <= v.length; i++) {
    if (rand() < 0.15 && trailingBackslashes(v.slice(0, i)) % 2 === 0) {
      pieces.push(v.slice(start, i));
      start = i;
    }
  }
  pieces.push(v.slice(start));
  return pieces;
}

/** Physical lines that mean nothing, for between logical lines. */
const FILLER = ['', ' ', '\t', '# comment', '#', '# key = value', '#[stanza]', '# ends in \\', '#\\'];

function serialise(stanzas: Stanza[], rand: () => number): string {
  const lines: string[] = [];
  const filler = () => {
    while (rand() < 0.3) lines.push(pick(rand, FILLER));
  };
  for (const s of stanzas) {
    filler();
    if (s.name !== null) {
      const pad = pick(rand, ['', ' ', '  ']);
      lines.push(`[${pad}${s.name}${pad}]${pick(rand, ['', ' ', '\t'])}`);
    }
    for (const { key: k, value: v } of s.pairs) {
      filler();
      const [first, ...rest] = cut(v, rand);
      const eq = `${pick(rand, ['', ' ', '\t'])}=${pick(rand, ['', ' ', '  '])}`;
      const physical = [`${k}${eq}${first}`, ...rest];
      // Every physical line but the last gets the continuation backslash.
      lines.push(...physical.map((p, i) => (i < physical.length - 1 ? `${p}\\` : p)));
    }
  }
  filler();
  return lines.map((l) => l + pick(rand, ['\n', '\r\n'])).join('');
}

/** The model as parseConf reports it: same-named stanzas merged, first appearance first. */
function expected(stanzas: Stanza[]): { name: string; pairs: Pair[] }[] {
  const out = new Map<string, Pair[]>();
  for (const s of stanzas) {
    if (s.name === null && s.pairs.length === 0) continue; // no implicit [default] without a directive
    const name = s.name ?? 'default';
    out.set(name, [...(out.get(name) ?? []), ...s.pairs]);
  }
  return [...out].map(([name, pairs]) => ({ name, pairs }));
}

const parsed = (text: string) =>
  parseConf(text, 'props.conf').stanzas.map((s) => ({
    name: s.name,
    pairs: s.directives.map((d) => ({ key: d.key, value: d.value })),
  }));

// ── Properties ──────────────────────────────────────────

describe('confParser — serialise → parse round-trips the directive map', () => {
  it('recovers every stanza, key and value, in order', () => {
    fc.assert(
      fc.property(model, layout, (stanzas, seed) => {
        const text = serialise(stanzas, prng(seed));
        expect(parsed(text)).toEqual(expected(stanzas));
        expect(parseConf(text, 'props.conf').errors.filter((e) => e.level === 'error')).toEqual([]);
      }),
    );
  });

  it('numbers each directive by the physical line its key is on', () => {
    fc.assert(
      fc.property(model, layout, (stanzas, seed) => {
        const text = serialise(stanzas, prng(seed));
        const physical = text.split(/\r?\n/);
        for (const s of parseConf(text, 'props.conf').stanzas) {
          for (const d of s.directives) {
            expect(physical[d.line - 1]!.startsWith(d.key)).toBe(true);
          }
        }
      }),
    );
  });
});

describe('confParser — continuation semantics', () => {
  /** Anything a physical line can hold, including what would otherwise be structure. */
  const anyLine = fc.oneof(
    fc.constantFrom('', '   ', '# comment', '[stanza]', '  [indented]', 'KEY = v', '  KEY = v', '\\', '\\\\', 'x\\', '=', '#\\'),
    fc.array(valueChar, { maxLength: 12 }).map((cs) => cs.join('')),
  );

  it('a trailing single backslash appends the next physical line, whatever it holds', () => {
    fc.assert(
      fc.property(value, anyLine, fc.constantFrom('\n', '\r\n'), (v, next, eol) => {
        const text = `[s]${eol}K = ${v}\\${eol}${next}${eol}AFTER = 1${eol}`;
        const conf = parseConf(text, 'props.conf');
        const directives = conf.stanzas.flatMap((s) => s.directives);
        const joined = v + next;
        // The joined value continues again only if `next` left it ending in an odd run.
        const continues = trailingBackslashes(joined) % 2 === 1;
        expect(directives[0]).toMatchObject({ key: 'K', line: 2 });
        if (continues) {
          expect(directives[0]!.value).toBe(`${joined.slice(0, -1)}AFTER = 1`);
          expect(directives).toHaveLength(1);
        } else {
          expect(directives[0]!.value).toBe(joined);
          expect(directives.map((d) => d.key)).toEqual(['K', 'AFTER']);
        }
        // The appended line is never read as structure of its own.
        expect(conf.stanzas.map((s) => s.name)).toEqual(['s']);
        expect(conf.errors).toEqual([]);
      }),
    );
  });

  it('an even run of trailing backslashes is literal and ends the value', () => {
    fc.assert(
      fc.property(value, fc.integer({ min: 1, max: 3 }), (v, pairs) => {
        const literal = `${v}${'\\\\'.repeat(pairs)}`;
        const directives = parseConf(`[s]\nK = ${literal}\nNEXT = 1\n`, 'props.conf').stanzas[0]!.directives;
        expect(directives.map((d) => [d.key, d.value])).toEqual([
          ['K', literal],
          ['NEXT', '1'],
        ]);
      }),
    );
  });
});
