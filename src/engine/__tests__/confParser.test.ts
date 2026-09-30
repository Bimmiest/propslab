import { describe, it, expect } from 'vitest';
import { parseConf } from '../parser/confParser';

function directives(text: string, stanzaName: string) {
  const parsed = parseConf(text, 'props.conf');
  const stanza = parsed.stanzas.find((s) => s.name === stanzaName);
  return stanza?.directives ?? [];
}

function value(text: string, stanzaName: string, key: string) {
  return directives(text, stanzaName).find((d) => d.key === key)?.value;
}

describe('parseConf — basic structure', () => {
  it('parses stanzas and key = value directives', () => {
    const parsed = parseConf('[mysourcetype]\nSHOULD_LINEMERGE = false', 'props.conf');
    expect(parsed.stanzas).toHaveLength(1);
    expect(parsed.stanzas[0]!.name).toBe('mysourcetype');
    expect(parsed.stanzas[0]!.directives[0]).toMatchObject({ key: 'SHOULD_LINEMERGE', value: 'false' });
  });

  it('treats # as a comment but NOT ;', () => {
    const parsed = parseConf('[s]\n# a comment\n; not a comment\nA = 1', 'props.conf');
    // The ";" line is not a comment — it becomes a malformed-line error, not a directive.
    expect(parsed.errors.some((e) => e.message.includes('Malformed'))).toBe(true);
  });
});

describe('parseConf — duplicate same-name stanzas merge (last-wins) (#59.1)', () => {
  it('merges repeated stanzas of the same name into one', () => {
    const parsed = parseConf('[st]\nKV_MODE = json\n[st]\nSHOULD_LINEMERGE = false', 'props.conf');
    expect(parsed.stanzas).toHaveLength(1);
    expect(parsed.stanzas[0]!.directives.map((d) => d.key)).toEqual(['KV_MODE', 'SHOULD_LINEMERGE']);
  });

  it('preserves file order so within-stanza last-wins picks the later value', () => {
    const parsed = parseConf('[st]\nKV_MODE = json\n[st]\nKV_MODE = none', 'props.conf');
    expect(parsed.stanzas).toHaveLength(1);
    // Both KV_MODE lines survive in order; mergeDirectives resolves last-wins.
    const kvValues = parsed.stanzas[0]!.directives.filter((d) => d.key === 'KV_MODE').map((d) => d.value);
    expect(kvValues).toEqual(['json', 'none']);
  });

  it('does not merge stanzas of different types with the same name', () => {
    const parsed = parseConf('[foo]\nA = 1\n[source::foo]\nB = 2', 'props.conf');
    expect(parsed.stanzas).toHaveLength(2);
  });
});

describe('parseConf — case-sensitive attribute names', () => {
  it('warns when a known attribute is mis-cased (Splunk ignores it)', () => {
    const parsed = parseConf('[aws]\nkv_mode = json', 'props.conf');
    const warn = parsed.errors.find((e) => e.directiveKey === 'kv_mode');
    expect(warn).toBeDefined();
    expect(warn!.level).toBe('warning');
    expect(warn!.message).toMatch(/case-sensitive/);
    expect(warn!.suggestion).toBe('Change "kv_mode" to "KV_MODE".');
    expect(warn!.line).toBe(2);
  });

  it('does not warn when the attribute is cased correctly', () => {
    const parsed = parseConf('[aws]\nKV_MODE = json', 'props.conf');
    expect(parsed.errors).toHaveLength(0);
  });

  it('does not warn for unknown attributes (avoids false positives)', () => {
    const parsed = parseConf('[s]\nMY_CUSTOM_THING = 1', 'props.conf');
    expect(parsed.errors).toHaveLength(0);
  });

  it('does not warn for class directives like EXTRACT-foo regardless of class-name case', () => {
    const parsed = parseConf('[s]\nEXTRACT-myField = (?<a>\\d+)', 'props.conf');
    expect(parsed.errors).toHaveLength(0);
  });
});

describe('parseConf — line continuation (SEM-18)', () => {
  it('joins a value continued with a trailing backslash', () => {
    const text = '[s]\nLINE_BREAKER = part1\\\npart2';
    expect(value(text, 's', 'LINE_BREAKER')).toBe('part1part2');
  });

  it('preserves leading whitespace of the continuation line', () => {
    const text = '[s]\nKEY = a\\\n    b';
    expect(value(text, 's', 'KEY')).toBe('a    b');
  });

  it('does NOT treat an escaped (even-count) trailing backslash as a continuation', () => {
    // `C:\\dir\\` ends with two backslashes (an escaped literal), so the next line
    // is its own directive, not a continuation.
    const text = '[s]\nPATH = C:\\\\dir\\\\\nOTHER = x';
    expect(value(text, 's', 'PATH')).toBe('C:\\\\dir\\\\');
    expect(value(text, 's', 'OTHER')).toBe('x');
  });

  it('a blank line ends the continuation and takes the backslash with it (#354)', () => {
    const text = '[s]\nKEY = a\\\n\nOTHER = b';
    // The blank line is the continuation, contributing nothing — the value used
    // to keep its dangling backslash.
    expect(value(text, 's', 'KEY')).toBe('a');
    expect(value(text, 's', 'OTHER')).toBe('b');
  });

  it('appends a # line after a continuation instead of skipping it (#354)', () => {
    // Doc-derived: the .conf spec continues a value onto the next line when it
    // ends in `\`, and makes no exception for a next line starting with `#`.
    // Skipping that line joined the NEXT directive into the value instead.
    const text = '[s]\nREGEX = foo\\\n# note\nTRUNCATE = 5';
    expect(value(text, 's', 'REGEX')).toBe('foo# note');
    expect(value(text, 's', 'TRUNCATE')).toBe('5');
  });

  it('counts a backslash-only continuation line with the backslashes before it', () => {
    // `x\\\` continues (odd run) and keeps `x\\`; the next line, `\`, makes the
    // joined run three, odd again, so the value continues onto `y` as well.
    const text = `[s]\nK = x${'\\'.repeat(3)}\n\\\ny\nO = 1`;
    expect(value(text, 's', 'K')).toBe(`x${'\\'.repeat(2)}y`);
    expect(value(text, 's', 'O')).toBe('1');
  });

  it('ends a value continued to the last line of the file', () => {
    expect(value('[s]\nK = a\\\nb\\\nc', 's', 'K')).toBe('abc');
  });

  it('parses a long run of continuation lines in linear time (#468)', () => {
    // Just under the MCP server's two-million-character conf limit. Appending
    // each line to the whole value made this take minutes.
    const text = `[st]\nEXTRACT-a = x\\\n${'a\\\n'.repeat(660_000)}`;
    const start = performance.now();
    const v = value(text, 'st', 'EXTRACT-a');
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(v).toBe(`x${'a'.repeat(660_000)}`);
  });
});

describe('parseConf — class-directive prefixes are case-sensitive (#60)', () => {
  it('does not classify a mis-cased prefix as a class directive', () => {
    const conf = parseConf('[st]\nextract-f = (?<a>\\d+)', 'props.conf');
    const dir = conf.stanzas[0]!.directives[0]!;
    expect(dir.directiveType).toBe('extract-f');
    expect(dir.className).toBeUndefined();
  });

  it('warns with the canonical spelling', () => {
    const conf = parseConf('[st]\nextract-f = (?<a>\\d+)', 'props.conf');
    const warning = conf.errors.find((e) => e.message.includes('case-sensitive'));
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('EXTRACT-f');
  });

  it('still accepts the correctly-cased form', () => {
    const conf = parseConf('[st]\nEXTRACT-f = (?<a>\\d+)', 'props.conf');
    const dir = conf.stanzas[0]!.directives[0]!;
    expect(dir.directiveType).toBe('EXTRACT');
    expect(dir.className).toBe('f');
    expect(conf.errors.some((e) => e.message.includes('case-sensitive'))).toBe(false);
  });

  it('flags a mixed-case prefix too', () => {
    const conf = parseConf('[st]\nExtract-f = (?<a>\\d+)', 'props.conf');
    expect(conf.errors.some((e) => e.message.includes('EXTRACT-f'))).toBe(true);
  });
});
