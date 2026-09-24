// ---------------------------------------------------------------------------
// evalProperties.test.ts
// Property-based tests for the eval lexer, parser and evaluator (#340).
//
// Example tests pin the cases someone thought of; #332 and #337 were both
// casing/position combinations nobody had. These generate expressions from the
// eval grammar instead — numbers (leading-dot and negative literals included),
// strings, fields named after the word operators, every operator with random
// keyword casing and whitespace, function calls, nested parens — and assert
// properties that must hold for all of them.
//
// Nothing here is a claim about Splunk's output: every property compares the
// simulator with itself (two spellings of one expression, or two expressions the
// SPL operator table defines as equivalent). No generated field is missing; the
// NULL-propagation properties in (e) name an absent field explicitly, now that
// #343 defined what a comparison against NULL yields.
//
// The seed is fixed so a run is reproducible; a failure prints the
// counterexample and fast-check's shrunk path.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseExpression, type Node } from '../processors/eval/parser';
import { evalNode } from '../processors/eval/evaluator';
import type { EvalValue } from '../processors/eval/values';
import type { SplunkEvent } from '../types';

fc.configureGlobal({ seed: 340, numRuns: 300 });

// ── Rendering ───────────────────────────────────────────
//
// A generated expression is a token list. `kw` tokens are case-insensitive words
// whose casing the renderer chooses; `raw` tokens are emitted as written.

type Tok = { kw: string } | { raw: string };

const kw = (w: string): Tok => ({ kw: w });
const raw = (s: string): Tok => ({ raw: s });

/** Operators around which the lexer needs no whitespace to split tokens. */
const SELF_DELIMITING = new Set(['(', ')', ',', '=', '==', '!=', '<', '>', '<=', '>=', '*', '/', '%', '+', '-']);

/**
 * Render `toks`, drawing keyword casing and inter-token whitespace from `rand`.
 * Whitespace may be omitted only next to a self-delimiting operator — between
 * two words, or around `.` (which would glue onto a number), it is required.
 */
function render(toks: Tok[], rand: () => number): string {
  let out = '';
  let prev: string | undefined;
  for (const t of toks) {
    const text = 'kw' in t ? randomCase(t.kw, rand) : t.raw;
    if (prev !== undefined) {
      const optional = SELF_DELIMITING.has(prev) || SELF_DELIMITING.has(text);
      const choices = optional ? ['', ' ', '  ', '\t', '\n'] : [' ', '  ', '\t', '\n', ' \n '];
      out += choices[Math.floor(rand() * choices.length)];
    }
    out += text;
    prev = text;
  }
  return out;
}

function randomCase(word: string, rand: () => number): string {
  return [...word].map((c) => (rand() < 0.5 ? c.toLowerCase() : c.toUpperCase())).join('');
}

/** Canonical rendering: upper-case keywords, single spaces. */
function canonical(toks: Tok[]): string {
  return toks.map((t) => ('kw' in t ? t.kw.toUpperCase() : t.raw)).join(' ');
}

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

// ── The grammar ─────────────────────────────────────────
//
// Each generated expression carries its tokens, the AST the parser must build
// for them, and its precedence level, so a parent knows whether the child needs
// parentheses. Levels follow parser.ts: OR/XOR 1, AND 2, prefix NOT 3,
// comparison/IN/LIKE 4 (non-associative), concatenation 5, + - 6, * / % 7,
// unary minus 8, primary 9.

interface Gen {
  toks: Tok[];
  node: Node;
  level: number;
}

/** Fields present on the test event. Every one is non-null, see the header. */
const EVENT_FIELDS: Record<string, string> = {
  a: 'x',
  b: 'X',
  n: '10',
  m: '2.5',
  e: '',
  // Named after the word operators: identifiers wherever a value is expected (#332).
  in: 'v',
  like: 'vx',
  xor: '1',
  and: '0',
  or: 'false',
  'x y': 'q',
};

const numberLit: fc.Arbitrary<Gen> = fc
  .oneof(
    fc.nat({ max: 999 }).map(String),
    fc.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 })).map(([i, f]) => `${i}.${f}`),
    // Leading-dot literal (#312).
    fc.nat({ max: 99 }).map((f) => `.${f}`),
    // Negative literal: the lexer folds `-` into the number in value position.
    fc.integer({ min: 1, max: 99 }).map((n) => `-${n}`),
  )
  .map((s) => ({ toks: [raw(s)], node: { kind: 'lit', value: parseFloat(s) }, level: 9 }));

const stringLit: fc.Arbitrary<Gen> = fc
  .string({ unit: fc.constantFrom('a', 'x', 'X', 'v', '1', '0', ' ', '%', '_', '"', '\\', '.', '-'), maxLength: 4 })
  .map((s) => ({
    toks: [raw(`"${s.replace(/[\\"]/g, '\\$&')}"`)],
    node: { kind: 'lit', value: s },
    level: 9,
  }));

const boolLit: fc.Arbitrary<Gen> = fc
  .boolean()
  .map((b) => ({ toks: [raw(String(b))], node: { kind: 'lit', value: b }, level: 9 }));

const fieldRef: fc.Arbitrary<Gen> = fc.constantFrom(...Object.keys(EVENT_FIELDS)).map((name) => ({
  // Field names are case-sensitive, so they are raw tokens, never re-cased.
  toks: [raw(/^\w+$/.test(name) ? name : `'${name}'`)],
  node: { kind: 'field', name },
  level: 9,
}));

const leaf = fc.oneof(numberLit, stringLit, boolLit, fieldRef);

/** `child` as an operand that the grammar parses at `minLevel` or above. */
function operand(child: Gen, minLevel: number): Tok[] {
  return child.level >= minLevel ? child.toks : [raw('('), ...child.toks, raw(')')];
}

/** A comma-separated argument list; any expression is allowed inside. */
function argList(args: Gen[]): Tok[] {
  return args.flatMap((a, i) => (i === 0 ? a.toks : [raw(','), ...a.toks]));
}

const ARITH_LEVEL: Record<string, number> = { '+': 6, '-': 6, '*': 7, '/': 7, '%': 7 };

const { expr } = fc.letrec<{ expr: Gen; compound: Gen }>((tie) => ({
  expr: fc.oneof({ depthSize: 'small', withCrossShrink: true }, leaf, tie('compound')),
  compound: fc.oneof(
    // Parenthesised — always legal, and resets the level.
    tie('expr').map((e): Gen => ({ toks: [raw('('), ...e.toks, raw(')')], node: e.node, level: 9 })),
    // Arithmetic: left-associative, so the left operand may share the level.
    fc.tuple(fc.constantFrom('+', '-', '*', '/', '%'), tie('expr'), tie('expr')).map(([op, l, r]): Gen => {
      const level = ARITH_LEVEL[op]!;
      return {
        toks: [...operand(l, level), raw(op), ...operand(r, level + 1)],
        node: { kind: 'arith', op, left: l.node, right: r.node },
        level,
      };
    }),
    fc.tuple(tie('expr'), tie('expr')).map(([l, r]): Gen => ({
      toks: [...operand(l, 5), raw('.'), ...operand(r, 6)],
      node: { kind: 'concat', left: l.node, right: r.node },
      level: 5,
    })),
    // Comparisons are non-associative: both operands sit above level 4.
    fc.tuple(fc.constantFrom('=', '==', '!=', '<', '>', '<=', '>='), tie('expr'), tie('expr')).map(([op, l, r]): Gen => ({
      toks: [...operand(l, 5), raw(op), ...operand(r, 5)],
      node: { kind: 'compare', op, left: l.node, right: r.node },
      level: 4,
    })),
    fc.tuple(tie('expr'), tie('expr')).map(([l, r]): Gen => ({
      toks: [...operand(l, 5), kw('LIKE'), ...operand(r, 5)],
      node: { kind: 'call', name: 'like', args: [l.node, r.node] },
      level: 4,
    })),
    fc.tuple(tie('expr'), fc.array(tie('expr'), { maxLength: 3 }), fc.boolean()).map(([v, list, negate]): Gen => ({
      toks: [...operand(v, 5), ...(negate ? [kw('NOT')] : []), kw('IN'), raw('('), ...argList(list), raw(')')],
      node: { kind: 'in', value: v.node, list: list.map((g) => g.node), negate },
      level: 4,
    })),
    // The in() function form; its name is as case-insensitive as the operator.
    fc.tuple(tie('expr'), fc.array(tie('expr'), { minLength: 1, maxLength: 3 })).map(([v, list]): Gen => ({
      toks: [kw('in'), raw('('), ...argList([v, ...list]), raw(')')],
      node: { kind: 'in', value: v.node, list: list.map((g) => g.node), negate: false },
      level: 9,
    })),
    // Prefix NOT takes a comparison-level operand, or another NOT.
    tie('expr').map((e): Gen => ({
      toks: [kw('NOT'), ...(e.level === 3 ? e.toks : operand(e, 4))],
      node: { kind: 'not', operand: e.node },
      level: 3,
    })),
    // Unary minus binds to a primary only.
    tie('expr')
      .filter((e) => !(e.node.kind === 'lit' && typeof e.node.value === 'number'))
      .map((e): Gen => ({
        toks: [raw('-'), ...operand(e, 9)],
        node: { kind: 'neg', operand: e.node },
        level: 8,
      })),
    fc.tuple(fc.constantFrom('AND', 'OR', 'XOR'), tie('expr'), tie('expr')).map(([op, l, r]): Gen => {
      const level = op === 'AND' ? 2 : 1;
      return {
        toks: [...operand(l, level), kw(op), ...operand(r, level + 1)],
        node: { kind: 'logical', op, left: l.node, right: r.node },
        level,
      };
    }),
    // Function calls whose results depend only on their arguments.
    fc
      .tuple(fc.constantFrom('if', 'len', 'lower', 'upper', 'coalesce', 'case', 'abs', 'tostring'), fc.array(tie('expr'), { maxLength: 3 }))
      .map(([name, args]): Gen => ({
        toks: [raw(name), raw('('), ...argList(args), raw(')')],
        node: { kind: 'call', name, args: args.map((g) => g.node) },
        level: 9,
      })),
  ),
}));

// ── Evaluation ──────────────────────────────────────────

const EVENT: SplunkEvent = {
  _raw: 'raw',
  _time: null,
  _meta: {},
  fields: EVENT_FIELDS,
  metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
  lineNumbers: { start: 1, end: 1 },
  processingTrace: [],
};

function evaluate(node: Node): EvalValue {
  return evalNode(node, { event: EVENT, now: 0 });
}

/** The outcome of parsing and evaluating `text`: a value, or the parse error. */
function outcome(text: string): { value: EvalValue } | { error: string } {
  let node: Node;
  try {
    node = parseExpression(text);
  } catch (e) {
    return { error: (e as Error).message };
  }
  return { value: evaluate(node) };
}

/** Parse errors are plain `Error`s; anything else is the parser crashing. */
function expectParseErrorOnly(text: string) {
  try {
    parseExpression(text);
  } catch (e) {
    expect(e, `input: ${JSON.stringify(text)}`).toBeInstanceOf(Error);
    expect((e as Error).constructor, `input: ${JSON.stringify(text)}`).toBe(Error);
  }
}

// ── (a) the parser only ever throws its own errors ──────

describe('eval parser robustness (#340)', () => {
  /** Fragments that exercise every lexer branch, glued together at random. */
  const fragment = fc.oneof(
    fc.constantFrom(
      'a', 'in', 'IN', 'In', 'not', 'NOT', 'like', 'LIKE', 'xor', 'XOR', 'and', 'OR', 'if', 'true', 'false',
      '(', ')', ',', '.', '-', '+', '*', '/', '%', '=', '==', '!=', '<', '>=', '!', '&&', '||',
      '"s"', '"', "'f'", "'", '1', '.5', '-1', '1.2.3', '1.', '#', '\\', ' ', '\n',
    ),
    fc.string({ maxLength: 3 }),
  );

  it('throws only its own parse errors on arbitrary token soup', () => {
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 25 }), fc.array(fc.constantFrom('', ' ')), (parts, seps) => {
        expectParseErrorOnly(parts.map((p, i) => p + (seps[i] ?? '')).join(''));
      }),
      { numRuns: 500 },
    );
  });

  it('throws only its own parse errors on arbitrary strings', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), (s) => expectParseErrorOnly(s)));
  });

  it('refuses deep nesting with its depth error, not a stack overflow', () => {
    const opener = fc.constantFrom('(', 'if(', 'NOT (', '-(', 'a IN (', 'a NOT in (', 'in(a, ');
    fc.assert(
      fc.property(fc.array(opener, { minLength: 1, maxLength: 4 }), fc.integer({ min: 1, max: 3000 }), (openers, depth) => {
        const text = Array.from({ length: depth }, (_, i) => openers[i % openers.length]).join('') + '1' + ')'.repeat(depth);
        expectParseErrorOnly(text);
      }),
      { numRuns: 100 },
    );
  });

  it('parses every expression the grammar generates, into the AST the grammar says', () => {
    fc.assert(
      fc.property(expr, fc.integer(), (g, seed) => {
        const text = render(g.toks, prng(seed));
        expect(normalize(parseExpression(text)), text).toEqual(normalize(g.node));
      }),
    );
  });
});

/** The AST with call names folded to lower case — the evaluator dispatches on that. */
function normalize(node: Node): Node {
  switch (node.kind) {
    case 'lit':
    case 'field':
      return node;
    case 'call':
      return { kind: 'call', name: node.name.toLowerCase(), args: node.args.map(normalize) };
    case 'arith':
    case 'concat':
    case 'compare':
    case 'logical':
      return { ...node, left: normalize(node.left), right: normalize(node.right) };
    case 'not':
    case 'neg':
      return { ...node, operand: normalize(node.operand) };
    case 'in':
      return { ...node, value: normalize(node.value), list: node.list.map(normalize) };
  }
}

// ── (b) keyword case and whitespace never change the result ──

describe('eval keyword casing and whitespace (#340)', () => {
  it('gives the same outcome for any casing of the keywords and any whitespace', () => {
    fc.assert(
      fc.property(expr, fc.integer(), fc.integer(), (g, s1, s2) => {
        const one = render(g.toks, prng(s1));
        const two = render(g.toks, prng(s2));
        expect(outcome(two), `${one}  vs  ${two}`).toEqual(outcome(one));
        expect(outcome(one), one).toEqual(outcome(canonical(g.toks)));
      }),
    );
  });
});

// ── (c) operator equivalences from the SPL operator table ──

describe('eval operator equivalences (#340)', () => {
  const list = fc.array(expr, { minLength: 1, maxLength: 4 });
  const cased = (w: string, seed: number) => randomCase(w, prng(seed));
  const text = (g: Gen) => canonical(g.toks);
  const items = (l: Gen[]) => l.map(text).join(', ');

  it('x NOT IN (l) is NOT (x IN (l))', () => {
    fc.assert(
      fc.property(expr, list, fc.integer(), fc.integer(), (x, l, s1, s2) => {
        const lhs = `(${text(x)}) ${cased('not', s1)} ${cased('in', s2)} (${items(l)})`;
        const rhs = `${cased('not', s2)} ((${text(x)}) ${cased('in', s1)} (${items(l)}))`;
        expect(outcome(lhs), lhs).toEqual(outcome(rhs));
        expect(outcome(lhs)).toHaveProperty('value');
      }),
    );
  });

  it('in(x, l) is x IN (l)', () => {
    fc.assert(
      fc.property(expr, list, fc.integer(), (x, l, s) => {
        const fn = `${cased('in', s)}(${text(x)}, ${items(l)})`;
        const op = `(${text(x)}) ${cased('in', s + 1)} (${items(l)})`;
        expect(outcome(fn), fn).toEqual(outcome(op));
        expect(outcome(fn)).toHaveProperty('value');
      }),
    );
  });

  it('NOT in(x, l) is x NOT IN (l)', () => {
    fc.assert(
      fc.property(expr, list, fc.integer(), (x, l, s) => {
        const fn = `${cased('not', s)} ${cased('in', s + 1)}(${text(x)}, ${items(l)})`;
        const op = `(${text(x)}) ${cased('not', s + 2)} ${cased('in', s + 3)}(${items(l)})`;
        expect(outcome(fn), fn).toEqual(outcome(op));
      }),
    );
  });

  it('a XOR b is (a OR b) AND NOT (a AND b) on booleans', () => {
    // Coerced through NOT NOT so both sides are booleans or NULL whatever the
    // operands are; three-valued logic keeps the identity for NULL too (#343).
    const bool = expr.map((g) => `NOT NOT (${text(g)})`);
    fc.assert(
      fc.property(bool, bool, fc.integer(), (a, b, s) => {
        const xor = `(${a}) ${cased('xor', s)} (${b})`;
        const expanded = `((${a}) OR (${b})) AND NOT ((${a}) AND (${b}))`;
        expect(outcome(xor), xor).toEqual(outcome(expanded));
        expect(outcome(xor)).toHaveProperty('value');
      }),
    );
  });
});

// ── (d) print → parse round trip ────────────────────────
//
// A printer in test code: fully parenthesised, so it needs no precedence
// knowledge, and it quotes any field name the lexer would not read back bare.

function print(node: Node): string {
  switch (node.kind) {
    case 'lit': {
      const v = node.value;
      if (typeof v === 'number') return v < 0 || Object.is(v, -0) ? `(${Object.is(v, -0) ? '-0' : String(v)})` : String(v);
      if (typeof v === 'string') return `"${v.replace(/[\\"]/g, '\\$&')}"`;
      if (typeof v === 'boolean') return String(v);
      throw new Error(`unprintable literal ${JSON.stringify(v)}`);
    }
    case 'field':
      return /^[A-Za-z_]\w*$/.test(node.name) && !/^(not|true|false)$/i.test(node.name) ? node.name : `'${node.name}'`;
    case 'call':
      return `${node.name}(${node.args.map(print).join(', ')})`;
    case 'arith':
    case 'compare':
      return `(${print(node.left)} ${node.op} ${print(node.right)})`;
    case 'concat':
      return `(${print(node.left)} . ${print(node.right)})`;
    case 'logical':
      return `(${print(node.left)} ${node.op} ${print(node.right)})`;
    case 'not':
      return `(NOT ${print(node.operand)})`;
    case 'neg':
      // The space keeps `- 5` a negation rather than the literal -5.
      return `(- ${print(node.operand)})`;
    case 'in':
      return `(${print(node.value)} ${node.negate ? 'NOT IN' : 'IN'} (${node.list.map(print).join(', ')}))`;
  }
}

describe('eval AST print/parse round trip (#340)', () => {
  it('parses a printed AST back to the same AST', () => {
    fc.assert(
      fc.property(expr, fc.integer(), (g, seed) => {
        const ast = parseExpression(render(g.toks, prng(seed)));
        const printed = print(ast);
        expect(parseExpression(printed), printed).toEqual(ast);
      }),
    );
  });
});

// ── (e) NULL propagation (#343) ─────────────────────────
//
// `missing` is not on the test event, so it evaluates to NULL. Whatever the
// other operand, a comparison, LIKE or IN involving it is NULL, and NULL is
// falsy: if() takes its else branch, and NOT does not turn it true.

describe('eval NULL propagation (#343)', () => {
  const text = (g: Gen) => canonical(g.toks);
  const op = fc.constantFrom('=', '==', '!=', '<', '>', '<=', '>=', 'LIKE');

  it('a comparison with an absent field is NULL, on either side', () => {
    fc.assert(
      fc.property(op, expr, (o, g) => {
        for (const e of [`missing ${o} (${text(g)})`, `(${text(g)}) ${o} missing`]) {
          expect(outcome(e), e).toEqual({ value: null });
        }
      }),
    );
  });

  it('takes the else branch of if(), with or without NOT', () => {
    fc.assert(
      fc.property(op, expr, fc.boolean(), (o, g, not) => {
        const cond = `${not ? 'NOT ' : ''}(missing ${o} (${text(g)}))`;
        const e = `if(${cond}, "then", "else")`;
        expect(outcome(e), e).toEqual({ value: 'else' });
      }),
    );
  });

  it('an absent field IN or NOT IN any list is NULL', () => {
    fc.assert(
      fc.property(fc.array(expr, { minLength: 1, maxLength: 3 }), fc.boolean(), (l, negate) => {
        const e = `missing ${negate ? 'NOT IN' : 'IN'} (${l.map(text).join(', ')})`;
        expect(outcome(e), e).toEqual({ value: null });
      }),
    );
  });

  it('NULL AND x is false or NULL, NULL OR x is true or NULL, never the other', () => {
    fc.assert(
      fc.property(expr, (g) => {
        const and = outcome(`(missing = 1) AND (${text(g)})`);
        const or = outcome(`(missing = 1) OR (${text(g)})`);
        expect([false, null]).toContainEqual((and as { value: EvalValue }).value);
        expect([true, null]).toContainEqual((or as { value: EvalValue }).value);
      }),
    );
  });
});
