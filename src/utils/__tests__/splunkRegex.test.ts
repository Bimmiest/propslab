import { describe, it, expect } from 'vitest';
import {
  cachedProbeCount,
  cachedRegexCount,
  extractionLimits,
  initRegexEngine,
  initRegexEngineSync,
  regexEngineModule,
  safeProbeRegex,
  safeRegex,
  SplunkRegex,
  validateRegex,
  regexError,
  DEFAULT_DEPTH_LIMIT,
  DEFAULT_MATCH_LIMIT,
} from '../splunkRegex';

// Patterns run on PCRE2 itself, so these pin PCRE semantics rather than a
// translation.

const matches = (pattern: string, s: string) => {
  const re = safeRegex(pattern);
  expect(re, pattern).not.toBeNull();
  return re!.test(s);
};

describe('PCRE syntax compiles and means what it means in PCRE', () => {
  it('honours inline flag groups, leading or mid-pattern', () => {
    expect(matches('(?i)error', 'ERROR')).toBe(true);
    // A mid-pattern group governs the rest of its enclosing group only.
    expect(matches('^a(?i)b$', 'aB')).toBe(true);
    expect(matches('^a(?i)b$', 'AB')).toBe(false);
    expect(matches('^(?i)a(?-i)b$', 'Ab')).toBe(true);
    expect(matches('^(?i)a(?-i)b$', 'AB')).toBe(false);
    expect(matches('^(?:a(?i)b|c)$', 'C')).toBe(true);
    expect(matches('^a(?i:b)c$', 'aBc')).toBe(true);
    expect(matches('^a(?i:b)c$', 'aBC')).toBe(false);
  });

  it('exposes Python and Perl named groups', () => {
    expect(safeRegex('(?P<num>\\d+)')!.exec('id 42')?.groups?.num).toBe('42');
    expect(safeRegex("(?'n'\\d+)")!.exec('id 42')?.groups?.n).toBe('42');
    expect(matches('^(?P<q>["\'])x(?P=q)$', '"x"')).toBe(true);
    expect(matches("^(?'n'a)\\k'n'\\g{n}\\g1$", 'aaaa')).toBe(true);
  });

  it('applies extended mode, with escaped and class-borne whitespace kept', () => {
    const re = safeRegex('(?x) ^ (?P<user> \\w+ ) \\s* = \\s* (?P<val> [^ ]+ ) # key = value');
    expect({ ...re!.exec('alice = 42')?.groups }).toEqual({ user: 'alice', val: '42' });
    expect(matches('(?x) ^a\\ b\\#[ #]c$', 'a b# c')).toBe(true);
    // Mid-pattern (?x) takes effect from there on, as PCRE has it.
    expect(matches('^a (?x) b c$', 'a bc')).toBe(true);
    expect(matches('^a b # c$', 'a b # c')).toBe(true);
  });

  it('reads a ] first in a class as a member', () => {
    // Doc-derived (pcre2pattern, "Square brackets and character classes").
    const cls = safeRegex('^[]a]$')!;
    expect(['a', ']'].map((s) => cls.test(s))).toEqual([true, true]);
    expect(['b', '', ']a'].map((s) => cls.test(s))).toEqual([false, false, false]);
    const neg = safeRegex('^[^]a]$')!;
    expect(['b', ' '].map((s) => neg.test(s))).toEqual([true, true]);
    expect(['a', ']', 'bc'].map((s) => neg.test(s))).toEqual([false, false, false]);
    expect(matches('^[]]+$', ']]')).toBe(true);
    expect(matches('^[^]]$', ']')).toBe(false);
    expect(matches('^[a]]$', 'a]')).toBe(true);
    expect(matches('^[a]]$', ']]')).toBe(false);
  });

  it('anchors \\A, \\z and \\Z at the subject', () => {
    expect(matches('\\Afoo', 'foo bar')).toBe(true);
    expect(matches('\\Afoo', 'Afoo')).toBe(false);
    expect(matches('(?m)\\Afoo', 'x\nfoo')).toBe(false);
    expect(matches('(?m)^foo', 'x\nfoo')).toBe(true);
    expect(matches('bar\\z', 'foo bar')).toBe(true);
    expect(matches('bar\\z', 'foo bar\n')).toBe(false);
    expect(matches('bar\\Z', 'foo bar\n')).toBe(true);
    expect(matches('bar\\Z', 'foo bar\n\n')).toBe(false);
  });

  it('matches $ before a final newline, which a JS regex does not', () => {
    expect(matches('bar$', 'foo bar\n')).toBe(true);
    expect(matches('bar$', 'foo bar\n\n')).toBe(false);
    expect(/bar$/.test('foo bar\n')).toBe(false);
  });

  it('lets . match \\r under LF newlines, which a JS regex does not', () => {
    expect(matches('^a.b$', 'a\rb')).toBe(true);
    expect(matches('^a.b$', 'a\nb')).toBe(false);
    expect(/^a.b$/.test('a\rb')).toBe(false);
  });

  it('reads \\h, \\H, \\v, \\V and \\R as PCRE whitespace sets', () => {
    expect(matches('a\\hb', 'a\tb')).toBe(true);
    expect(matches('a\\hb', 'a\nb')).toBe(false);
    expect(matches('a\\Hb', 'a b')).toBe(false);
    expect(matches('a\\vb', 'a\rb')).toBe(true);
    expect(matches('a\\Vb', 'a\nb')).toBe(false);
    expect(matches('^a\\Rb$', 'a\r\nb')).toBe(true);
    expect(matches('^[^x\\H]$', ' ')).toBe(true);
  });

  it('matches \\Q…\\E literally and knows POSIX classes', () => {
    expect(matches('^\\Q(1+1)\\E$', '(1+1)')).toBe(true);
    expect(matches('^[\\Q]-^\\E]+$', '^]-')).toBe(true);
    expect(matches('^[[:alpha:][:digit:]_]+$', 'ab_12')).toBe(true);
    expect(matches('^[[:punct:]]+$', '!/:@[`{~')).toBe(true);
    expect(matches('^[[:^digit:]]$', '5')).toBe(false);
    expect(validateRegex('[[:digt:]]')).toMatch(/unknown POSIX class/);
  });

  it('keeps possessive quantifiers and atomic groups from giving anything back', () => {
    expect(matches('^a++a', 'aaa')).toBe(false);
    expect(matches('^a+a', 'aaa')).toBe(true);
    expect(matches('^(?>a+)a', 'aaa')).toBe(false);
    expect(matches('^\\d*+\\d', '123')).toBe(false);
    // Inside a class the characters are just members.
    expect(matches('^[*+]+$', '+*')).toBe(true);
  });

  it('supports recursion, \\K, conditionals, \\G and Unicode properties', () => {
    expect(safeRegex('\\((?:[^()]|(?R))*\\)')!.exec('x(a(b)c)y')![0]).toBe('(a(b)c)');
    const k = safeRegex('user=\\K\\w+')!.exec('user=bob')!;
    expect([k[0], k.index]).toEqual(['bob', 5]);
    const cond = safeRegex('^(<)?\\w+(?(1)>)$')!;
    expect([cond.test('<a>'), cond.test('a'), cond.test('<a')]).toEqual([true, true, false]);
    expect(safeRegex('\\Gab')!.matchAll('ababxab').map((m) => m.index)).toEqual([0, 2]);
    expect(matches('^\\p{Lu}\\p{Ll}+$', 'Élan')).toBe(true);
    expect(matches('^\\X$', 'é')).toBe(true);
    expect(matches('^(a)\\g{-1}$', 'aa')).toBe(true);
  });

  it('keeps \\w and \\d ASCII unless the pattern asks for Unicode', () => {
    expect(matches('^\\w+$', 'café')).toBe(false);
    expect(matches('(*UCP)^\\w+$', 'café')).toBe(true);
    // `.` is a whole character, astral ones included.
    expect(safeRegex('^.$')!.exec('😀')?.index).toBe(0);
  });

  it('reports offsets as JS string indices', () => {
    const m = safeRegex('(?<v>x+)')!.exec('😀é xx')!;
    expect(m.index).toBe(4);
    expect(m.indices.groups?.v).toEqual([4, 6]);
  });
});

describe('iteration', () => {
  it('advances past an empty match the way PCRE does', () => {
    const re = safeRegex('x*')!;
    expect(re.matchAll('axxb').map((m) => [m.index, m[0]])).toEqual([
      [0, ''],
      [1, 'xx'],
      [3, ''],
      [4, ''],
    ]);
  });

  it('starts where it is told to, with lookbehind still seeing the text before', () => {
    const re = safeRegex('(?<=\\})(\\n)')!;
    expect(re.exec('{a}\n{b}\n', 4)?.index).toBe(7);
  });

  it('replaces through a callback, one match or all', () => {
    const re = safeRegex('(\\d)')!;
    expect(re.replace('a1b2', (m) => `<${m[1]}>`, false)).toBe('a<1>b2');
    expect(re.replace('a1b2', (m) => `<${m[1]}>`, true)).toBe('a<1>b<2>');
  });
});

describe('validation', () => {
  it('returns PCRE2 message and offset for a pattern it rejects', () => {
    expect(validateRegex('(abc')).toMatch(/missing closing parenthesis/);
    expect(regexError('ab(c')?.offset).toBe(4);
    expect(validateRegex('[\\A]')).not.toBeNull();
    expect(validateRegex('(?<=a+)b')).toMatch(/lookbehind/);
    expect(validateRegex('ok')).toBeNull();
    expect(safeRegex('(abc')).toBeNull();
  });

  it('no longer refuses a pattern for being ReDoS-prone: the limits bound it', () => {
    expect(validateRegex('(\\d+)+')).toBeNull();
    expect(safeRegex('(a+)+$')).not.toBeNull();
  });

  it('refuses flags that are not PCRE options', () => {
    expect(() => safeRegex('a', 'g')).toThrow(/Unknown flag/);
  });
});

describe('MATCH_LIMIT and DEPTH_LIMIT', () => {
  const runaway = `${'a'.repeat(30)}b`;

  it('uses Splunk defaults when unset, and 0 as unlimited', () => {
    expect(extractionLimits()).toEqual({ matchLimit: DEFAULT_MATCH_LIMIT, depthLimit: DEFAULT_DEPTH_LIMIT });
    expect(extractionLimits('500000', '5000')).toEqual({ matchLimit: 500000, depthLimit: 5000 });
    expect(extractionLimits('0', '0')).toEqual({ matchLimit: 0xffffffff, depthLimit: 0xffffffff });
    expect(extractionLimits('-1', 'lots')).toEqual({ matchLimit: DEFAULT_MATCH_LIMIT, depthLimit: DEFAULT_DEPTH_LIMIT });
  });

  it('counts a match that hits the limit as no match, and says why', () => {
    const re = safeRegex('^(a+)+$', '', extractionLimits())!;
    expect(re.exec(runaway)).toBeNull();
    expect(re.lastError).toMatch(/match limit exceeded/);
    // The next call clears it.
    expect(re.exec('aaa')).not.toBeNull();
    expect(re.lastError).toBeUndefined();
  });

  it('a higher MATCH_LIMIT lets the same match run to its answer', () => {
    const subject = `${'a'.repeat(14)}b`;
    const low = safeRegex('^(a+)+$', '', extractionLimits('1000'))!;
    const high = safeRegex('^(a+)+$', '', extractionLimits('1000000'))!;
    expect(low.test(subject)).toBe(false);
    expect(low.lastError).toMatch(/match limit/);
    expect(high.test(subject)).toBe(false);
    expect(high.lastError).toBeUndefined();
  });

  it('stops deep backtracking at DEPTH_LIMIT', () => {
    const re = safeRegex('^(?:a|b)*$', '', extractionLimits(undefined, '50'))!;
    expect(re.test('ab'.repeat(200))).toBe(false);
    expect(re.lastError).toMatch(/depth limit/);
    expect(safeRegex('^(?:a|b)*$', '', extractionLimits())!.test('ab'.repeat(200))).toBe(true);
  });

  it('ends an iteration where the limit was hit', () => {
    const re = safeRegex('(?:x(a+)+$)|y', '', { matchLimit: 1000 })!;
    expect(re.matchAll(`y y x${'a'.repeat(30)}b`).map((m) => m[0])).toEqual(['y', 'y']);
    expect(re.lastError).toMatch(/match limit/);
  });
});

describe('compiled-pattern cache', () => {
  it('stays bounded and recompiles an evicted pattern on its next use', () => {
    const first = new SplunkRegex('first(\\d)');
    for (let i = 0; i < 400; i++) new SplunkRegex(`evict${i}`);
    expect(cachedRegexCount()).toBeLessThanOrEqual(256);
    expect(first.exec('first7')?.[1]).toBe('7');
  });

  it('keeps diagnostic probes out of the shared cache (#415)', () => {
    const before = cachedRegexCount();
    for (let i = 0; i < 400; i++) expect(safeProbeRegex(`probe${i}`)?.test(`probe${i}`)).toBe(true);
    expect(cachedRegexCount()).toBe(before);
    expect(cachedProbeCount()).toBeLessThanOrEqual(256);
    expect(safeProbeRegex('(unbalanced')).toBeNull();
  });
});

describe('a second engine init', () => {
  // A cached pattern holds code in the replaced instance's memory; running it
  // after a re-init threw "belongs to an earlier init()".
  it('recompiles cached patterns instead of running them against the old instance', async () => {
    const held = new SplunkRegex('reinit(\\d)');
    expect(held.exec('reinit1')?.[1]).toBe('1');

    initRegexEngineSync(regexEngineModule());
    expect(cachedRegexCount()).toBe(0);
    expect(held.exec('reinit2')?.[1]).toBe('2');
    expect(safeRegex('reinit(\\d)')?.exec('reinit3')?.[1]).toBe('3');

    await initRegexEngine(regexEngineModule());
    expect(cachedRegexCount()).toBe(0);
    expect(held.exec('reinit4')?.[1]).toBe('4');
  });
});
