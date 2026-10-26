// ---------------------------------------------------------------------------
// noOpExplainer.test.ts
// Why a directive did nothing.
//
// The partial-match tests carry the most weight: a wrong offset is worse than
// no offset, because it sends someone to the wrong character with confidence.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  longestPartialMatch,
  explainNoMatch,
  explainRegexNoOp,
  describeNoOp,
  noOpDirectiveKey,
  type NoOpReason,
} from '../noOpExplainer';
import { validateRegex } from '../../utils/splunkRegex';

describe('longestPartialMatch', () => {
  it('reports where the pattern stopped agreeing with the text', () => {
    // `user=(?<user>\w+)@` — the text has a space where the @ is expected.
    const partial = longestPartialMatch(String.raw`user=(?<user>\w+)@`, 'user=alice logged in');
    expect(partial?.end).toBe('user=alice'.length);
  });

  it('never cuts a pattern in the middle of a group', () => {
    // A naive character-count truncation yields `user=(?<user>\w`, which does
    // not compile — the boundary walk has to keep groups whole.
    const partial = longestPartialMatch(String.raw`user=(?<user>\w+)@`, 'user=alice logged in');
    expect(partial?.prefix).toBe(String.raw`user=(?<user>\w+)`);
  });

  it('keeps a quantifier with the atom it governs', () => {
    const partial = longestPartialMatch(String.raw`\d{4}-\d{2}-XX`, '2024-01-15');
    expect(partial?.prefix).toBe(String.raw`\d{4}-\d{2}-`);
    expect(partial?.end).toBe('2024-01-'.length);
  });

  it('handles a character class containing a bracket', () => {
    const partial = longestPartialMatch(String.raw`\[[^\]]+\]\sZZZ`, '[warn] something');
    expect(partial?.end).toBe('[warn] '.length);
  });

  it('reads a POSIX class and a leading ] as PCRE does (#561)', () => {
    // A scan to the first `]` cut `[[:digit:]]+x` after `[[:digit:]`, which
    // does not compile, and reported that nothing matched.
    expect(longestPartialMatch('[[:digit:]]+x', '123y')).toEqual({ end: 3, prefix: '[[:digit:]]+' });
    expect(longestPartialMatch('[]a]+Z', ']a]b')).toEqual({ end: 3, prefix: '[]a]+' });
  });

  it('drops a cut that does not compile rather than read it as a miss (#561)', () => {
    // The scan cuts inside `\k<w>`; those prefixes do not compile.
    expect(longestPartialMatch(String.raw`(?<w>a)\k<w>Z`, 'aab')).toEqual({ end: 2, prefix: String.raw`(?<w>a)\k<w>` });
  });

  it('returns null when not even the first atom matches', () => {
    // Nothing to report beats reporting offset 0 as though it were a finding.
    expect(longestPartialMatch(String.raw`ZZZ\d+`, 'nothing alike here')).toBeNull();
  });

  it('reads an escaped parenthesis as a literal, not a group', () => {
    expect(longestPartialMatch(String.raw`\(\d+\)X`, '(12)y')).toEqual({ end: 4, prefix: String.raw`\(\d+\)` });
  });

  it('reads a parenthesis inside a character class as a literal', () => {
    expect(longestPartialMatch('[(]+X', '((y')).toEqual({ end: 2, prefix: '[(]+' });
  });

  it('keeps a counted quantifier with the atom it governs', () => {
    // Cut inside `{2,3}`, the prefix reads `{` as a literal and stops agreeing
    // after one `a`.
    expect(longestPartialMatch('a{2,3}b', 'aac')).toEqual({ end: 2, prefix: 'a{2,3}' });
  });

  it('reports nothing when only the first alternative agrees', () => {
    expect(longestPartialMatch('ERRORX|FATAL', 'ERROR here')).toBeNull();
  });

  it('reports nothing for a top-level alternation rather than an empty-matching prefix (#365)', () => {
    // `ERROR|` matches the empty string at 0, which is not agreement.
    expect(longestPartialMatch('ERROR|FATAL', 'all good here')).toBeNull();
    expect(explainRegexNoOp('ERROR|FATAL', 'all good here', '_raw')).toEqual({ kind: 'no-match' });
  });

  it('does not count an empty match as agreement', () => {
    expect(longestPartialMatch(String.raw`x*ZZZ`, 'nothing alike here')).toBeNull();
  });

  it('still cuts inside a group that holds an alternation', () => {
    const partial = longestPartialMatch(String.raw`(?:GET|POST) /api`, 'GET /web');
    expect(partial?.end).toBe('GET /'.length);
  });

  it('does not report a partial for a pattern that matches outright', () => {
    // Callers only reach this after a failed match; if it does match, the
    // longest proper prefix is still reported rather than the whole pattern.
    const partial = longestPartialMatch(String.raw`user=\w+`, 'user=alice');
    expect(partial?.prefix).not.toBe(String.raw`user=\w+`);
  });
});

describe('explainRegexNoOp', () => {
  it('names a pattern that does not compile', () => {
    const reason = explainRegexNoOp('(unbalanced', 'anything', '_raw');
    expect(reason?.kind).toBe('regex-invalid');
  });

  it('gives the compiler error, not a generic message', () => {
    const error = validateRegex('(unbalanced');
    expect(error).toBeTruthy();
    expect(explainRegexNoOp('(unbalanced', 'anything', '_raw')).toEqual({ kind: 'regex-invalid', error });
  });

  it('says the pattern stopped at a limit rather than that it did not match', () => {
    const reason = explainRegexNoOp('^(?<v>(?:a|b)*)$', 'ab'.repeat(600), '_raw', { depthLimit: 1000 });
    expect(reason?.kind).toBe('regex-limit');
  });

  it('reports an empty source before blaming the pattern', () => {
    // The order matters: a perfectly good regex against an empty SOURCE_KEY
    // should not be reported as a non-matching regex.
    const reason = explainRegexNoOp(String.raw`\w+`, '', 'MetaData:Host');
    expect(reason).toEqual({ kind: 'source-key-empty', sourceKey: 'MetaData:Host' });
  });

  it('treats an absent source the same as an empty one', () => {
    const reason = explainRegexNoOp(String.raw`\w+`, undefined, 'my_field');
    expect(reason?.kind).toBe('source-key-empty');
  });

  it('returns null when the directive actually fired', () => {
    expect(explainRegexNoOp(String.raw`user=(?<u>\w+)`, 'user=alice', '_raw')).toBeNull();
  });

  it('reports a non-match with the partial offset', () => {
    const reason = explainRegexNoOp(String.raw`user=(?<user>\w+)@`, 'user=alice here', '_raw');
    expect(reason).toMatchObject({ kind: 'no-match', partialEnd: 'user=alice'.length });
  });

  it('reports a non-match with no partial when nothing agrees', () => {
    const reason = explainRegexNoOp(String.raw`ZZZ\d+`, 'nothing alike', '_raw');
    expect(reason).toEqual({ kind: 'no-match' });
  });
});

describe('describeNoOp', () => {
  it('names the stanza that won when one did', () => {
    expect(describeNoOp({ kind: 'stanza-not-matched', stanza: 'my_app', wonInstead: 'source::/var/log' })).toContain(
      '[source::/var/log] won instead',
    );
  });

  it('reads as a sentence for every kind', () => {
    const reasons: NoOpReason[] = [
      { kind: 'stanza-not-matched', stanza: 'a' },
      { kind: 'transforms-stanza-missing', name: 'mask' },
      { kind: 'regex-invalid', error: 'x' },
      { kind: 'source-key-empty', sourceKey: '_raw' },
      { kind: 'no-match' },
      { kind: 'no-match', partialEnd: 4 },
      { kind: 'fields-already-set', fields: ['user'] },
      { kind: 'not-explained' },
    ];
    for (const reason of reasons) {
      const text = describeNoOp(reason);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('undefined');
    }
  });

  it('agrees in number when several fields were already set', () => {
    expect(describeNoOp({ kind: 'fields-already-set', fields: ['a', 'b'] })).toContain('were already set');
    expect(describeNoOp({ kind: 'fields-already-set', fields: ['a'] })).toContain('was already set');
    expect(describeNoOp({ kind: 'no-named-groups' })).toContain('has no named capture group');
    expect(describeNoOp({ kind: 'groups-unset', fields: ['a', 'b'] })).toContain('a, b took no part in the match');
  });

  it('says an EVAL computed null without guessing why (#772)', () => {
    // In a sourcetype with several record types the usual cause is a case()
    // that returns null on purpose, with every field it reads present.
    expect(describeNoOp({ kind: 'eval-null', expression: 'len(x)' })).toBe(
      '`len(x)` evaluated to null, so no field was written',
    );
  });

  it('names each field in the exact sentences', () => {
    expect(describeNoOp({ kind: 'fields-already-set', fields: ['a', 'b'] })).toBe(
      'it matched, but a, b were already set by an earlier rule',
    );
    expect(describeNoOp({ kind: 'values-empty', fields: ['a', 'b'] })).toBe(
      'it matched, but a, b captured only whitespace, and an empty value creates no field',
    );
    expect(describeNoOp({ kind: 'regex-invalid', error: 'missing )' })).toBe('the pattern did not compile: missing )');
  });

  it('says plainly when an event was past the explanation limit', () => {
    expect(describeNoOp({ kind: 'not-explained' })).toBe('Not analysed: explanation limit reached for this directive');
  });
});

describe('explainNoMatch', () => {
  it('analyses a miss while the directive has explanations left', () => {
    expect(explainNoMatch(String.raw`user=(?<user>\w+)@`, 'user=alice here', true)).toMatchObject({
      kind: 'no-match',
      partialEnd: 'user=alice'.length,
    });
  });

  it('does not analyse a miss past the limit, and says so', () => {
    expect(explainNoMatch(String.raw`user=(?<user>\w+)@`, 'user=alice here', false)).toEqual({ kind: 'not-explained' });
  });
});

describe('noOpDirectiveKey', () => {
  it('keeps two directives on the same line apart', () => {
    const a = noOpDirectiveKey({ file: 'props.conf', line: 3, directive: 'EXTRACT-a' });
    expect(a).not.toBe(noOpDirectiveKey({ file: 'props.conf', line: 3, directive: 'EXTRACT-b' }));
    expect(a).not.toBe(noOpDirectiveKey({ file: 'transforms.conf', line: 3, directive: 'EXTRACT-a' }));
  });
});
