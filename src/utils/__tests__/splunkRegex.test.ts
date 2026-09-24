import { describe, it, expect } from 'vitest';
import { safeRegex, translatePcreToJs, hasReDoSRisk, SUPPORTS_SCOPED_MODIFIERS } from '../splunkRegex';

describe('translatePcreToJs', () => {
  it('hoists a leading inline flag group into the flags', () => {
    const { source, flags } = translatePcreToJs('(?i)error');
    expect(source).toBe('error');
    expect(flags).toContain('i');
  });

  it('merges multiple inline flag letters and preserves passed flags', () => {
    const { source, flags } = translatePcreToJs('(?ims)foo', 'g');
    expect(source).toBe('foo');
    expect(flags.split('').sort().join('')).toBe('gims');
  });

  it('converts Python named groups and backreferences', () => {
    const { source } = translatePcreToJs('(?P<word>\\w+)\\s(?P=word)');
    expect(source).toBe('(?<word>\\w+)\\s\\k<word>');
  });

  it('rewrites atomic groups to non-capturing groups', () => {
    expect(translatePcreToJs('(?>abc)d').source).toBe('(?:abc)d');
  });

  it('converts possessive quantifiers to greedy ones', () => {
    expect(translatePcreToJs('a++').source).toBe('a+');
    expect(translatePcreToJs('\\w*+').source).toBe('\\w*');
    expect(translatePcreToJs('x?+').source).toBe('x?');
    expect(translatePcreToJs('\\d{2,3}+').source).toBe('\\d{2,3}');
  });

  it('leaves an escaped literal quantifier char untouched', () => {
    // `\++` = one-or-more literal plus signs — valid JS, must not be stripped.
    expect(translatePcreToJs('\\++').source).toBe('\\++');
  });
});

describe('translatePcreToJs — class- and escape-aware rewrites (#290)', () => {
  it('leaves quantifier characters inside a character class alone', () => {
    // `[*+]` is "a star or a plus". The old regex-replace pass read `*+` as a
    // possessive star and produced `[*]`, silently dropping the plus.
    expect(translatePcreToJs('[*+]').source).toBe('[*+]');
    expect(translatePcreToJs('[?+]+x').source).toBe('[?+]+x');
    expect(translatePcreToJs('[a-z]{2}+[}+]').source).toBe('[a-z]{2}[}+]');
    expect(safeRegex('[*+]')!.test('+')).toBe(true);
  });

  it('treats an escaped backslash before a possessive plus as an escape, not an escaped plus', () => {
    // `\\++` is "one or more backslashes, possessively" → `\\+`.
    expect(translatePcreToJs('\\\\++').source).toBe('\\\\+');
  });

  it('keeps a lazy quantifier lazy and does not read the lazy marker as a new quantifier', () => {
    expect(translatePcreToJs('a+?b').source).toBe('a+?b');
    expect(translatePcreToJs('a*?+').source).toBe('a*?+');
  });

  it('strips a possessive after a group and leaves a literal brace alone', () => {
    expect(translatePcreToJs('(ab)++c').source).toBe('(ab)+c');
    expect(translatePcreToJs('{x}+').source).toBe('{x}+');
  });

  it('does not rewrite group syntax that appears inside a class or after an escape', () => {
    expect(translatePcreToJs('[(?P<x>]').source).toBe('[(?P<x>]');
    expect(translatePcreToJs('\\(?>').source).toBe('\\(?>');
    expect(translatePcreToJs('a[(?i)]').flags).toBe('');
  });
});

describe('translatePcreToJs — a `]` first in a character class (#341)', () => {
  // Doc-derived (pcre2pattern, "Square brackets and character classes"): a
  // closing square bracket "should be the first data character in the class
  // (after an initial circumflex, if present)" to be a member. JS instead reads
  // `[]` as an empty class and `[^]` as any character, so a class copied
  // verbatim meant something else entirely.
  it.each([
    ['[]a]', '[\\]a]'],
    ['[^]a]', '[^\\]a]'],
    ['[]]', '[\\]]'],
    ['[^]]', '[^\\]]'],
  ])('escapes the leading ] in %s', (pcre, js) => {
    expect(translatePcreToJs(pcre)).toEqual({ source: js, flags: '', warnings: [] });
  });

  it('matches what PCRE matches', () => {
    // `[]a]` is one character, `]` or `a`.
    const cls = safeRegex('^[]a]$')!;
    expect(['a', ']'].map((s) => cls.test(s))).toEqual([true, true]);
    expect(['b', '', ']a'].map((s) => cls.test(s))).toEqual([false, false, false]);
    // `[^]a]` is one character that is neither.
    const neg = safeRegex('^[^]a]$')!;
    expect(['b', ' '].map((s) => neg.test(s))).toEqual([true, true]);
    expect(['a', ']', 'bc'].map((s) => neg.test(s))).toEqual([false, false, false]);
    // `[]]` and `[^]]`: just the bracket, and anything but it.
    expect(safeRegex('^[]]+$')!.test(']]')).toBe(true);
    expect(safeRegex('^[]]$')!.test('a')).toBe(false);
    expect(safeRegex('^[^]]$')!.test('a')).toBe(true);
    expect(safeRegex('^[^]]$')!.test(']')).toBe(false);
  });

  it('finds the class end past the leading ], so later syntax is still translated', () => {
    // The `++` after the class is possessive, not text inside it.
    expect(translatePcreToJs('[]a]++').source).toBe('[\\]a]+');
    expect(translatePcreToJs('(?P<b>[^]x])').source).toBe('(?<b>[^\\]x])');
  });

  it('leaves a ] that is not first alone: [a]] is class a, then a literal ]', () => {
    expect(translatePcreToJs('[a]]').source).toBe('[a]]');
    const re = safeRegex('^[a]]$')!;
    expect(re.test('a]')).toBe(true);
    expect(re.test('a')).toBe(false);
    expect(re.test(']]')).toBe(false);
  });
});

describe('translatePcreToJs — extended mode (#290)', () => {
  it('strips unescaped whitespace and # comments when (?x) leads the pattern', () => {
    const { source, flags } = translatePcreToJs('(?x) (?P<ip> \\d+ (?: \\. \\d+ ){3} )  # the address\n \\s+ port');
    expect(source).toBe('(?<ip>\\d+(?:\\.\\d+){3})\\s+port');
    expect(flags).toBe('');
  });

  it('keeps escaped whitespace, an escaped #, and whitespace or # inside a class', () => {
    expect(translatePcreToJs('(?x) a\\ b \\# [ #] c').source).toBe('a\\ b\\#[ #]c');
  });

  it('matches the way the extended pattern reads', () => {
    const re = safeRegex('(?x) ^ (?P<user> \\w+ ) \\s* = \\s* (?P<val> [^ ]+ ) # key = value');
    expect({ ...re!.exec('alice = 42')?.groups }).toEqual({ user: 'alice', val: '42' });
  });

  it('combines with other leading flags, in one group or across groups', () => {
    expect(translatePcreToJs('(?xi) a b').source).toBe('ab');
    expect(translatePcreToJs('(?xi) a b').flags).toBe('i');
    const split = translatePcreToJs('(?x)  # comment\n (?i) a b');
    expect(split.source).toBe('ab');
    expect(split.flags).toBe('i');
  });

  it('keeps a quantifier possessive across ignorable whitespace', () => {
    expect(translatePcreToJs('(?x) a+ + b').source).toBe('a+b');
  });

  it('does not apply extended mode when (?x) is not leading, and says so', () => {
    const { source, warnings } = translatePcreToJs('a (?x) b', '', { scopedModifiers: true });
    expect(source).toBe('a  b');
    expect(warnings.join(' ')).toMatch(/\(\?x\) is only applied at the start/);
  });

  it('leaves whitespace significant without (?x)', () => {
    expect(translatePcreToJs('a b # c').source).toBe('a b # c');
  });
});

describe('translatePcreToJs — mid-pattern inline flags (#290)', () => {
  const scoped = { scopedModifiers: true };

  it('keeps a leading flag group as a whole-pattern flag', () => {
    expect(translatePcreToJs('(?i)abc', '', scoped)).toEqual({ source: 'abc', flags: 'i', warnings: [] });
  });

  it('scopes a mid-pattern flag group to the rest of the enclosing group', () => {
    expect(translatePcreToJs('ab(?i)cd', '', scoped)).toEqual({ source: 'ab(?i:cd)', flags: '', warnings: [] });
    expect(translatePcreToJs('x(a(?i)b)c', '', scoped).source).toBe('x(a(?i:b))c');
    expect(translatePcreToJs('^(?i)foo', '', scoped).source).toBe('^(?i:foo)');
  });

  it('wraps each later alternative separately, so the alternation is not captured', () => {
    // PCRE: `a(?i)b|c` is (a, then case-insensitive b) OR case-insensitive c.
    // One wrapper spanning the `|` would instead mean "a, then b or c".
    expect(translatePcreToJs('a(?i)b|c', '', scoped).source).toBe('a(?i:b)|(?i:c)');
    expect(translatePcreToJs('(a(?i)b|c)d', '', scoped).source).toBe('(a(?i:b)|(?i:c))d');
  });

  it('nests successive flag groups and drops letters JS cannot scope', () => {
    expect(translatePcreToJs('a(?i)b(?s)c', '', scoped).source).toBe('a(?i:b(?s:c))');
    expect(translatePcreToJs('a(?iU)b', '', scoped).source).toBe('a(?i:b)');
    expect(translatePcreToJs('a(?U)b', '', scoped).source).toBe('ab');
  });

  it('closes wrappers even when the pattern is unbalanced, leaving the error to the compiler', () => {
    expect(translatePcreToJs('(a(?i)b', '', scoped).source).toBe('(a(?i:b)');
    expect(translatePcreToJs('a(?i)b)c', '', scoped).source).toBe('a(?i:b))c');
  });

  it('hoists to a whole-pattern flag with a warning when scoped groups are unavailable', () => {
    const { source, flags, warnings } = translatePcreToJs('ab(?i)cd', '', { scopedModifiers: false });
    expect(source).toBe('abcd');
    expect(flags).toBe('i');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/applied to the whole pattern/);
  });

  it('probes the runtime rather than assuming support', () => {
    let supported = true;
    try {
      new RegExp('(?i:a)');
    } catch {
      supported = false;
    }
    expect(SUPPORTS_SCOPED_MODIFIERS).toBe(supported);
  });

  // Node 24 (the pinned runtime, and CI's) and current browsers support scoped
  // modifier groups; Node 22 has them only behind a flag, where the hoist
  // fallback above is what runs.
  it.runIf(SUPPORTS_SCOPED_MODIFIERS)('matches only the text after the flag group case-insensitively', () => {
    const re = safeRegex('ab(?i)cd')!;
    expect(re.test('abCD')).toBe(true);
    expect(re.test('ABcd')).toBe(false);
    const alt = safeRegex('^(?:a(?i)b|c)$')!;
    expect(alt.test('aB')).toBe(true);
    expect(alt.test('C')).toBe(true);
    expect(alt.test('Ab')).toBe(false);
  });

  it('still analyses the body of a scoped group for ReDoS', () => {
    const { source } = translatePcreToJs('a(?i)(x+)+', '', scoped);
    expect(source).toBe('a(?i:(x+)+)');
    expect(hasReDoSRisk(source)).toBe(true);
    expect(hasReDoSRisk('(?i:(x+)+)')).toBe(true);
    expect(hasReDoSRisk('(?i-s:\\d+\\.)+')).toBe(false);
  });
});

describe('safeRegex with PCRE syntax', () => {
  it('compiles and case-insensitively matches an inline-flag pattern', () => {
    const re = safeRegex('(?i)error');
    expect(re).not.toBeNull();
    expect(re!.test('ERROR')).toBe(true);
  });

  it('compiles a possessive quantifier instead of returning null', () => {
    const re = safeRegex('a++');
    expect(re).not.toBeNull();
    expect(re!.test('aaa')).toBe(true);
  });

  it('exposes Python named groups as JS named captures', () => {
    const re = safeRegex('(?P<num>\\d+)');
    expect(re).not.toBeNull();
    expect(re!.exec('id 42')?.groups?.num).toBe('42');
  });

  it('still rejects nested-quantifier ReDoS patterns', () => {
    expect(safeRegex('(\\d+)+')).toBeNull();
  });
});

describe('hasReDoSRisk — strengthened heuristic (#11/#34)', () => {
  // Catastrophic families that previously slipped through and could freeze the
  // main-thread live regex testers.
  it.each([
    '(\\d+)+',        // nested quantified group (existing)
    '(.+)*x',         // nested group, star outer
    '(.*,){20}',      // bounded repetition of a group with an inner quantifier
    'a*a*',           // adjacent same-atom quantifiers
    '\\d+\\d+',       // adjacent same-atom quantifiers (escaped atom)
    'a*a*a*a*a*a*a*c', // long adjacent run
  ])('flags catastrophic pattern %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(true);
    expect(safeRegex(p)).toBeNull();
  });

  // Benign patterns must still compile — no false positives.
  it.each([
    '(foo|bar)+',     // benign alternation (NOT flagged — needs real overlap analysis)
    'a+b+',           // different atoms
    '\\d+\\.\\d+',    // digits.digits (dot between, not adjacent same atom)
    '(ab){3}',        // bounded group with no inner quantifier
    '\\d{2,3}',       // a plain bound
    '(?<num>\\d+)',   // a single named group
  ])('does not flag benign pattern %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(false);
    expect(safeRegex(p)).not.toBeNull();
  });
});

describe('hasReDoSRisk — ambiguity analysis (#55)', () => {
  // Safe, idiomatic patterns that the presence-only heuristic rejected, silently
  // disabling valid config. Each repeats a group whose inner quantifier IS
  // reliably terminated, so there is only one way to split the input.
  it.each([
    '(\\d+\\.){3}\\d+',      // canonical IPv4 — `\d+` cannot match the `.`
    '^(?:[^ ]* ){2}',        // Splunk docs' own TIME_PREFIX recipe
    '(?:[^,]*,)+',           // CSV field walk
    '(?:[^"]*"){2}',         // walk to the second quote
    '(?:\\d+[a-z]+)+',       // boundary is the group's own start, and it is unambiguous
    '(?:\\[[^\\]]*\\])+',    // bracketed segments
  ])('does not flag safe repeated group %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(false);
    expect(safeRegex(p)).not.toBeNull();
  });

  // Genuinely ambiguous repetitions stay rejected.
  it.each([
    '(a+)+',                 // classic nested quantifier
    '(\\w+)*',
    '(?:\\d*)*',
    '([a-z]+\\w*)+',         // `\w` overlaps `[a-z]`
    '(\\s*\\S*)+',           // body can match empty
    '(?:\\w+=\\S+\\s*)+',    // trailing `\S+` can eat the next iteration's `\w+`
  ])('flags ambiguous repeated group %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(true);
    expect(safeRegex(p)).toBeNull();
  });
});
