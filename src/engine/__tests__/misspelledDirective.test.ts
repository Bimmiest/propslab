import { describe, it, expect } from 'vitest';
import { isOneEditApart, misspelledCanonical, MISSPELLED_MESSAGE } from '../misspelledDirective';
import { parseConf } from '../parser/confParser';

describe('isOneEditApart', () => {
  it.each([
    ['a substitution', 'time_format', 'time_formet'],
    ['a transposition', 'time_format', 'time_fromat'],
    ['a transposition of the last two', 'kv_mode', 'kv_moed'],
    ['a transposition of the first two', 'kv_mode', 'vk_mode'],
    ['an extra character', 'truncate', 'trunccate'],
    ['an extra character at the end', 'truncate', 'truncatee'],
    ['a missing character', 'truncate', 'truncte'],
    ['a missing first character', 'truncate', 'runcate'],
  ])('is true for %s', (_name, a, b) => {
    expect(isOneEditApart(a, b)).toBe(true);
    expect(isOneEditApart(b, a)).toBe(true);
  });

  it.each([
    ['equal strings', 'truncate', 'truncate'],
    ['two substitutions', 'truncate', 'trxncatx'],
    ['two extra characters', 'truncate', 'truncateee'],
    ['a swap of characters that are not adjacent', 'abcd', 'dbca'],
    ['a swap and a substitution', 'abcde', 'bacdx'],
    ['an extra character and a substitution', 'abcd', 'xabce'],
    ['two extra characters, one at each end', 'bc', 'abcd'],
    ['a swap whose first half does not match', 'abcd', 'bxcd'],
    ['a swap whose second half does not match', 'abcd', 'xacd'],
  ])('is false for %s', (_name, a, b) => {
    expect(isOneEditApart(a, b)).toBe(false);
    expect(isOneEditApart(b, a)).toBe(false);
  });
});

describe('misspelledCanonical (#899)', () => {
  it.each([
    ['TIME_FROMAT', 'props.conf', 'TIME_FORMAT'],
    ['TRUNCTE', 'props.conf', 'TRUNCATE'],
    ['SHOULD_LINEMEGRE', 'props.conf', 'SHOULD_LINEMERGE'],
    ['time_fromat', 'props.conf', 'TIME_FORMAT'],
    ['EXTRCT-ip', 'props.conf', 'EXTRACT-ip'],
    ['TRANSFROMS-route', 'props.conf', 'TRANSFORMS-route'],
    ['EXTRCT-a-b', 'props.conf', 'EXTRACT-a-b'],
    ['DEST_KYE', 'transforms.conf', 'DEST_KEY'],
  ] as const)('reads %s in %s as %s', (key, file, expected) => {
    expect(misspelledCanonical(key, file)).toBe(expected);
  });

  it.each([
    ['a real attribute', 'TIME_FORMAT', 'props.conf'],
    ['a real class key', 'EXTRACT-ip', 'props.conf'],
    ['a key that differs only by case', 'time_format', 'props.conf'],
    ['a class key whose prefix differs only by case', 'extract-ip', 'props.conf'],
    ['an attribute of the other file', 'REGEX', 'props.conf'],
    ['a key far from every attribute', 'NOT_A_THING_AT_ALL', 'props.conf'],
    ['a key of three letters', 'TZZ', 'props.conf'],
    ['a key longer than any attribute', `${'TIME_FORMAT'.repeat(6)}X`, 'props.conf'],
  ] as const)('has no suggestion for %s', (_name, key, file) => {
    expect(misspelledCanonical(key, file)).toBeUndefined();
  });

  it('checks a key of four letters, the shortest it reads, and not one of three', () => {
    expect(misspelledCanonical('REGX', 'transforms.conf')).toBe('REGEX');
    // TZ is one edit away, but three letters reach too many attributes.
    expect(misspelledCanonical('TZX', 'props.conf')).toBeUndefined();
  });

  it('reads a class prefix only with a class name after it', () => {
    expect(misspelledCanonical('EVL-x', 'props.conf')).toBe('EVAL-x');
    expect(misspelledCanonical('EVL-', 'props.conf')).toBeUndefined();
  });

  it('compares a key with no class prefix only with the plain attributes', () => {
    // EVAL is a class prefix: without a dash and a class name it is no attribute.
    expect(misspelledCanonical('EVALX', 'props.conf')).toBeUndefined();
    expect(misspelledCanonical('EVALXY', 'props.conf')).toBeUndefined();
  });

  it('has no suggestion when the key is one edit from two attributes', () => {
    // max_matches and min_matches are two edits apart, and mix_matches is one
    // from each: which one was meant cannot be told.
    expect(misspelledCanonical('mix_matches', 'transforms.conf')).toBeUndefined();
    expect(misspelledCanonical('max_matchez', 'transforms.conf')).toBe('max_matches');
  });

  it('words its message with the key, the file and the attribute', () => {
    expect(MISSPELLED_MESSAGE('TIME_FROMAT', 'TIME_FORMAT', 'props.conf')).toBe(
      '"TIME_FROMAT" is not a props.conf attribute, so Splunk ignores the line. Did you mean "TIME_FORMAT"?',
    );
  });
});

describe('parseConf reports a misspelled key (#899)', () => {
  it('warns on the line, with the attribute in the message and the suggestion', () => {
    const { errors } = parseConf('[st]\nTIME_FORMAT = %Y\nTIME_FROMAT = %Y\n', 'props.conf');
    expect(errors).toEqual([
      {
        level: 'warning',
        message: MISSPELLED_MESSAGE('TIME_FROMAT', 'TIME_FORMAT', 'props.conf'),
        file: 'props.conf',
        line: 3,
        directiveKey: 'TIME_FROMAT',
        suggestion: 'Change "TIME_FROMAT" to "TIME_FORMAT".',
      },
    ]);
  });

  it('reports a mis-cased key once, as mis-cased', () => {
    const { errors } = parseConf('[st]\ntime_format = %Y\n', 'props.conf');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/case-sensitive/);
  });

  it('keeps the directive, which Splunk ignores but the stanza still holds', () => {
    const { stanzas } = parseConf('[st]\nTIME_FROMAT = %Y\n', 'props.conf');
    expect(stanzas[0]?.directives.map((d) => d.key)).toEqual(['TIME_FROMAT']);
  });
});
