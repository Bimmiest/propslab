import { describe, it, expect } from 'vitest';
import { cachedStanzaPatternCount, matchStanzas, mergeDirectives, stanzaPatternProblem } from '../parser/stanzaMatcher';
import { parseConf } from '../parser/confParser';
import { runPipeline } from '../pipeline';
import type { ConfDirective, ConfStanza, EventMetadata } from '../types';

function stanza(type: ConfStanza['type'], name: string): ConfStanza {
  return { name, type, directives: [], lineRange: { start: 1, end: 2 } };
}

function dir(key: string, value: string, line: number): ConfDirective {
  return { key, value, line, directiveType: key };
}

const META: EventMetadata = {
  index: 'main',
  host: 'webserver01',
  source: '/var/log/apache/access.log',
  sourcetype: 'access_combined',
};

/** A `[source::<pattern>]` stanza, as parseConf would build it. */
function source(pattern: string): ConfStanza {
  return {
    name: `source::${pattern}`,
    type: 'source',
    sourcePattern: pattern,
    directives: [],
    lineRange: { start: 1, end: 2 },
  };
}

/** A `[host::<pattern>]` stanza, as parseConf would build it. */
function host(pattern: string): ConfStanza {
  return {
    name: `host::${pattern}`,
    type: 'host',
    hostPattern: pattern,
    directives: [],
    lineRange: { start: 1, end: 2 },
  };
}

const at = (path: string): EventMetadata => ({ ...META, source: path });
const onHost = (name: string): EventMetadata => ({ ...META, host: name });

/** Whether `stanza` matches an event with `meta`. */
const matches = (stanza: ConfStanza, meta: EventMetadata): boolean => matchStanzas([stanza], meta).length === 1;

/** Names of the matching stanzas, in precedence order. */
const order = (stanzas: ConfStanza[], meta: EventMetadata): string[] => matchStanzas(stanzas, meta).map((s) => s.name);

describe('matchStanzas — precedence ordering', () => {
  it('source wins over host, sourcetype, and default', () => {
    const stanzas = [
      stanza('default', 'default'),
      stanza('sourcetype', 'access_combined'),
      stanza('host', 'webserver01'),
      stanza('source', '/var/log/apache/access.log'),
    ];
    const result = matchStanzas(stanzas, META);
    expect(result[0]!.type).toBe('source');
  });

  it('host wins over sourcetype and default', () => {
    const stanzas = [
      stanza('default', 'default'),
      stanza('sourcetype', 'access_combined'),
      stanza('host', 'webserver01'),
    ];
    const result = matchStanzas(stanzas, META);
    expect(result[0]!.type).toBe('host');
  });

  it('sourcetype wins over default', () => {
    const stanzas = [stanza('default', 'default'), stanza('sourcetype', 'access_combined')];
    const result = matchStanzas(stanzas, META);
    expect(result[0]!.type).toBe('sourcetype');
  });

  it('returns all four types in order: source, host, sourcetype, default', () => {
    const stanzas = [
      stanza('default', 'default'),
      stanza('sourcetype', 'access_combined'),
      stanza('host', 'webserver01'),
      stanza('source', '/var/log/apache/access.log'),
    ];
    const result = matchStanzas(stanzas, META);
    expect(result.map((s) => s.type)).toEqual(['source', 'host', 'sourcetype', 'default']);
  });

  it('unmatched stanza types are excluded', () => {
    const stanzas = [stanza('sourcetype', 'wrong_sourcetype'), stanza('default', 'default')];
    const result = matchStanzas(stanzas, META);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('default');
  });
});

describe('matchStanzas — wildcard patterns', () => {
  it('source wildcard * matches single path segment', () => {
    const s: ConfStanza = {
      name: 'source::/var/log/apache/*',
      type: 'source',
      sourcePattern: '/var/log/apache/*',
      directives: [],
      lineRange: { start: 1, end: 2 },
    };
    const result = matchStanzas([s], META);
    expect(result).toHaveLength(1);
  });

  it('source wildcard does not match across path separators', () => {
    const s: ConfStanza = {
      name: 'source::/var/log/*',
      type: 'source',
      sourcePattern: '/var/log/*',
      directives: [],
      lineRange: { start: 1, end: 2 },
    };
    // /var/log/apache/access.log has more segments than * allows
    const result = matchStanzas([s], META);
    expect(result).toHaveLength(0);
  });

  it('... matches recursively across path separators', () => {
    const s: ConfStanza = {
      name: 'source::/var/log/...',
      type: 'source',
      sourcePattern: '/var/log/...',
      directives: [],
      lineRange: { start: 1, end: 2 },
    };
    const result = matchStanzas([s], META);
    expect(result).toHaveLength(1);
  });

  // Doc-derived (props.conf.spec, stanza patterns): "." matches a period.
  it('reads `.` as a literal period, not any character', () => {
    expect(matches(host('a.b.c.d'), onHost('a.b.c.d'))).toBe(true);
    expect(matches(host('a.b.c.d'), onHost('aXbXcXd'))).toBe(false);
    expect(matches(source('/var/log/*.log'), at('/var/log/appXlog'))).toBe(false);
  });
});

describe('mergeDirectives — duplicate keys', () => {
  it('takes the LAST value when a key is repeated within one stanza (Splunk last-wins)', () => {
    const s = stanza('sourcetype', 'st');
    s.directives = [dir('TRUNCATE', '100', 1), dir('TRUNCATE', '500', 2)];
    const merged = mergeDirectives([s]);
    const truncate = merged.filter((d) => d.key === 'TRUNCATE');
    expect(truncate).toHaveLength(1);
    expect(truncate[0]!.value).toBe('500');
  });

  it('keeps the higher-precedence stanza when the same key appears across stanzas', () => {
    const source = stanza('source', '/v');
    source.directives = [dir('KV_MODE', 'json', 1)];
    const sourcetype = stanza('sourcetype', 'st');
    sourcetype.directives = [dir('KV_MODE', 'none', 1)];
    // matchStanzas would order source before sourcetype; emulate that order here.
    const merged = mergeDirectives([source, sourcetype]);
    expect(merged.find((d) => d.key === 'KV_MODE')?.value).toBe('json');
  });
});

describe('matchStanzas — host case-insensitivity (#118)', () => {
  // Doc-derived (props.conf.spec): "[source::<source>] and [<sourcetype>]
  // stanzas match in a case-sensitive manner, while [host::<host>] stanzas
  // match in a case-insensitive manner."
  const meta = (host: string): EventMetadata => ({ ...META, host });

  it('matches a host stanza whose case differs from the event', () => {
    const stanzas = [stanza('host', 'WebServer01')];
    expect(matchStanzas(stanzas, meta('webserver01'))).toHaveLength(1);
  });

  it('matches when the event host is the upper-cased one', () => {
    const stanzas = [stanza('host', 'webserver01')];
    expect(matchStanzas(stanzas, meta('WEBSERVER01'))).toHaveLength(1);
  });

  it('still applies wildcards after case folding', () => {
    const stanzas = [stanza('host', 'WEB*01')];
    expect(matchStanzas(stanzas, meta('webserver01'))).toHaveLength(1);
  });

  it('does not match a genuinely different host', () => {
    const stanzas = [stanza('host', 'WebServer02')];
    expect(matchStanzas(stanzas, meta('webserver01'))).toHaveLength(0);
  });

  it('keeps `source::` case-SENSITIVE — only host folds', () => {
    // Splunk treats source as case-sensitive; the folding must not leak across.
    const stanzas = [stanza('source', '/VAR/LOG/apache/access.log')];
    expect(matchStanzas(stanzas, META)).toHaveLength(0);
  });
});

// Doc-derived (props.conf.spec, [source::<source>]): "`|` is equivalent to
// 'or'. `( )` are used to limit scope of `|`." That is PCRE alternation, and a
// source pattern is PCRE only when it contains `*` or `...` (#442).
describe('matchStanzas — `|` alternation and `( )` scoping (#284, #442)', () => {
  it('matches either branch of a scoped alternation', () => {
    const s = source('.../(messages|secure)');
    expect(matches(s, at('/var/log/secure'))).toBe(true);
    expect(matches(s, at('/var/log/messages'))).toBe(true);
  });

  it('does not match outside the alternatives, or the pattern text itself', () => {
    const s = source('.../(messages|secure)');
    expect(matches(s, at('/var/log/maillog'))).toBe(false);
    expect(matches(s, at('/var/log/(messages|secure)'))).toBe(false);
  });

  it('anchors a top-level alternation at both ends', () => {
    // Without a wrapping group, `^a|b$` would accept anything starting with
    // the first branch or ending with the second.
    const s = source('/var/log/messages|/var/log/secure*');
    expect(matches(s, at('/var/log/messages'))).toBe(true);
    expect(matches(s, at('/var/log/secure.1'))).toBe(true);
    expect(matches(s, at('/var/log/messages.1'))).toBe(false);
    expect(matches(s, at('/tmp/var/log/secure'))).toBe(false);
  });

  it('keeps wildcards working inside a group', () => {
    const s = source('/var/log/(app|web)/*.log');
    expect(matches(s, at('/var/log/web/access.log'))).toBe(true);
    expect(matches(s, at('/var/log/web/sub/access.log'))).toBe(false);
    expect(matches(source('/var/(...|tmp)/x'), at('/var/a/b/x'))).toBe(true);
  });

  it('matches nothing with `|` in a pattern that has no wildcard', () => {
    // #442 corrected this. These patterns used to be read as alternations
    // with no wildcard in them; Splunk compares such a pattern as written, and
    // one containing `|` then matches no source at all.
    const scoped = source('/var/log/(messages|secure)');
    expect(matches(scoped, at('/var/log/secure'))).toBe(false);
    expect(matches(scoped, at('/var/log/messages'))).toBe(false);
    expect(matches(scoped, at('/var/log/(messages|secure)'))).toBe(false);
    const topLevel = source('/var/log/messages|/var/log/secure');
    expect(matches(topLevel, at('/var/log/secure'))).toBe(false);
    expect(matches(topLevel, at('/var/log/messages|/var/log/secure'))).toBe(false);
  });

  it('reads a parenthesis in a pattern with no wildcard as itself', () => {
    expect(matches(source('/var/log/app(1.log'), at('/var/log/app(1.log'))).toBe(true);
    expect(matches(source('/var/log/app1).log'), at('/var/log/app1).log'))).toBe(true);
  });

  it('gives an alternation pattern the pattern-stanza default priority', () => {
    // A literal source stanza defaults to 100 and a pattern one to 0, so the
    // literal wins although the pattern sorts first in ASCII.
    expect(order([source('.../(messages|secure)'), source('/var/log/secure')], at('/var/log/secure'))).toEqual([
      'source::/var/log/secure',
      'source::.../(messages|secure)',
    ]);
  });
});

// Doc-derived (props.conf.spec, stanza pattern syntax): "\\ = matches a literal
// backslash '\'". That is PCRE's escape, and holds where the pattern is PCRE:
// always for a host pattern, and for a source pattern containing `*` or `...`.
// A source pattern with neither is compared as written (#442), so there `\\` is
// two backslashes.
describe('matchStanzas — backslashes in a source pattern (#303, #442)', () => {
  // The conf text `C:\\logs\\app.log`, i.e. written the way the spec says.
  const SPEC_WINDOWS = 'C:\\\\logs\\\\app.log';

  it('matches a Windows path written per the spec when the pattern has a wildcard', () => {
    const s = source('C:\\\\logs\\\\*.log');
    expect(matches(s, at('C:\\logs\\app.log'))).toBe(true);
    // `*` stops at a path separator, and a backslash is one.
    expect(matches(s, at('C:\\logs\\sub\\app.log'))).toBe(false);
  });

  it('compares a pattern with no wildcard as written, so `\\` there is two backslashes', () => {
    // #442 corrected this. It used to read `\\` as one backslash in every
    // pattern, matching `C:\logs\app.log` and not the source spelled as the
    // stanza is.
    expect(matches(source(SPEC_WINDOWS), at('C:\\\\logs\\\\app.log'))).toBe(true);
    expect(matches(source(SPEC_WINDOWS), at('C:\\logs\\app.log'))).toBe(false);
  });

  it('still reads a lone backslash as itself, so existing configs keep matching', () => {
    expect(matches(source('C:\\logs\\app.log'), at('C:\\logs\\app.log'))).toBe(true);
  });

  it('compares backslashes one for one in a pattern with no wildcard', () => {
    // #442 corrected this. Backslashes used to pair up as escapes, so three
    // matched two; compared as written, three match only three.
    expect(matches(source('a\\\\\\b'), at('a\\\\\\b'))).toBe(true);
    expect(matches(source('a\\\\\\b'), at('a\\\\b'))).toBe(false);
  });

  it('reads `\\` as one backslash in a host pattern, which is always PCRE', () => {
    expect(matches(host('ad\\\\web'), onHost('ad\\web'))).toBe(true);
    expect(matches(host('ad\\\\web'), onHost('ad\\\\web'))).toBe(false);
  });

  it('keeps a backslashed pattern with no wildcard a literal-matching stanza', () => {
    // Literal, so it defaults to priority 100 and beats the wildcard stanza
    // that sorts before it in ASCII.
    expect(order([source('...app.log'), source(SPEC_WINDOWS)], at('C:\\\\logs\\\\app.log'))).toEqual([
      `source::${SPEC_WINDOWS}`,
      'source::...app.log',
    ]);
  });

  it('survives the conf parser: the stanza header keeps its backslashes', () => {
    const conf = parseConf(
      '[source::C:\\\\logs\\\\*.log]\nTRUNCATE = 5\n\n[source::C:\\\\x]\nTRUNCATE = 6\n',
      'props.conf',
    );
    expect(matchStanzas(conf.stanzas, at('C:\\logs\\app.log'))).toHaveLength(1);
    expect(matchStanzas(conf.stanzas, at('C:\\\\x'))).toHaveLength(1);
  });
});

describe('matchStanzas — ASCII order breaks a full tie (#318)', () => {
  // Doc-derived: props.conf.spec resolves colliding patterns of equal priority
  // by the ASCII order of the stanza, the one sorting first winning. What this
  // pins is that file order does not decide it.
  const tied = (first: string, second: string) =>
    parseConf(
      `[source::${first}]\nSEDCMD-who = s/M/${first}/\n\n[source::${second}]\nSEDCMD-who = s/M/${second}/\n`,
      'props.conf',
    ).stanzas;
  const meta: EventMetadata = { ...META, source: '/logs/app_a_app_z.log' };

  it('puts the ASCII-lower stanza first whichever comes first in the file', () => {
    const forward = matchStanzas(tied('...app_a...', '...app_z...'), meta).map((s) => s.name);
    const reversed = matchStanzas(tied('...app_z...', '...app_a...'), meta).map((s) => s.name);
    expect(forward).toHaveLength(2);
    expect(forward).toEqual(reversed);
    expect(forward[0]).toContain('...app_a...');
  });

  it('compares bytes, so an uppercase name sorts before a lowercase one', () => {
    const stanzas = tied('...app_a...', '...APP_A...');
    const result = matchStanzas(stanzas, { ...meta, source: '/logs/app_a_APP_A_z.log' }).map((s) => s.name);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('...APP_A...');
  });

  it('does not override priority', () => {
    const stanzas = parseConf(
      '[source::...app_a...]\nSEDCMD-who = s/M/a/\n\n[source::...app_z...]\npriority = 5\nSEDCMD-who = s/M/z/\n',
      'props.conf',
    ).stanzas;
    expect(matchStanzas(stanzas, meta)[0]!.name).toContain('...app_z...');
  });
});

// Doc-derived (props.conf.spec, [<spec>] stanza patterns): "suppose two [<spec>]
// stanzas supply the same setting. In this case, Splunk software chooses the
// value to apply based on the ASCII order of the patterns in question." #443
// established that nothing comes before it: the more specific pattern does not
// win.
describe('matchStanzas — no specificity rule before ASCII order (#443)', () => {
  it('lets the ASCII-first pattern win over a more specific one', () => {
    // #443 corrected this. The stanza with more literal characters used to
    // rank first, so `/var/log/x443/...` won.
    const stanzas = [source('/var/log/x443/...'), source('.../app443.log')];
    const expected = ['source::.../app443.log', 'source::/var/log/x443/...'];
    expect(order(stanzas, at('/var/log/x443/sub/app443.log'))).toEqual(expected);
    expect(order([...stanzas].reverse(), at('/var/log/x443/sub/app443.log'))).toEqual(expected);
  });

  it('lets the shorter of two nested directory patterns win when it sorts first', () => {
    const stanzas = [source('/var/log/b/sub/...'), source('/var/log/b/...')];
    expect(order(stanzas, at('/var/log/b/sub/f.log'))).toEqual([
      'source::/var/log/b/...',
      'source::/var/log/b/sub/...',
    ]);
  });

  it('orders host patterns the same way', () => {
    expect(order([host('web-01.*'), host('w*')], onHost('web-01.example'))).toEqual(['host::w*', 'host::web-01.*']);
  });
});

// Doc-derived (props.conf.spec, [source::<source>]): "Match expressions must
// match the entire name, not just a substring. Match expressions are based on a
// full implementation of Perl-compatible regular expressions (PCRE) with the
// translation of "...", "*", and "." Thus, "." matches a period, "*" matches
// non-directory separators, and "..." matches any number of any characters."
// #442 established that regex syntax works before, inside and after the
// wildcard segment.
describe('matchStanzas — a source pattern with a wildcard is PCRE (#442)', () => {
  it('reads `?` as a quantifier', () => {
    const s = source('.../app.ab?c');
    expect(matches(s, at('/x/app.ac'))).toBe(true);
    expect(matches(s, at('/x/app.abc'))).toBe(true);
    expect(matches(s, at('/x/app.abXc'))).toBe(false);
  });

  it('matches a rotated-log suffix', () => {
    const s = source('.../app.log(.\\d+)?');
    expect(matches(s, at('/var/log/app.log'))).toBe(true);
    expect(matches(s, at('/var/log/app.log.1'))).toBe(true);
    expect(matches(s, at('/var/log/app.logX'))).toBe(false);
  });

  it('honours groups, alternation, `\\d` and character classes before the wildcard', () => {
    expect(matches(source('/x/pre(a|b)/*.log'), at('/x/prea/f.log'))).toBe(true);
    expect(matches(source('/x/pre(a|b)/*.log'), at('/x/prec/f.log'))).toBe(false);
    expect(matches(source('/x/pd\\d/*.log'), at('/x/pd5/f.log'))).toBe(true);
    expect(matches(source('/x/pd\\d/*.log'), at('/x/pdX/f.log'))).toBe(false);
    expect(matches(source('/x/pc[0-9]/*.log'), at('/x/pc7/f.log'))).toBe(true);
    expect(matches(source('/x/pc[0-9]/*.log'), at('/x/pcX/f.log'))).toBe(false);
  });

  it('honours a lookbehind', () => {
    const s = source('.../lb....(?<!tar.)(gzz|bzz)');
    expect(matches(s, at('/x/lb_a.gzz'))).toBe(true);
    expect(matches(s, at('/x/lb_b.bzz'))).toBe(true);
    expect(matches(s, at('/x/lb_a.tar.gzz'))).toBe(false);
  });

  it('must match the whole source, not a substring', () => {
    const s = source('/x/*.log');
    expect(matches(s, at('/x/f.log'))).toBe(true);
    expect(matches(s, at('/x/f.log.1'))).toBe(false);
    expect(matches(s, at('/pre/x/f.log'))).toBe(false);
  });

  it('stops `*` at either path separator', () => {
    expect(matches(source('/x/*.log'), at('/x/a/b.log'))).toBe(false);
    expect(matches(source('/x/*.log'), at('/x/a\\b.log'))).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(matches(source('.../App.log'), at('/x/App.log'))).toBe(true);
    expect(matches(source('.../App.log'), at('/x/app.log'))).toBe(false);
  });

  it('leaves an escaped character as PCRE reads it', () => {
    const s = source('.../a\\*b');
    expect(matches(s, at('/x/a*b'))).toBe(true);
    expect(matches(s, at('/x/ab'))).toBe(false);
  });

  it('leaves the inside of a character class as PCRE reads it', () => {
    const s = source('.../f[.*]');
    expect(matches(s, at('/x/f.'))).toBe(true);
    expect(matches(s, at('/x/f*'))).toBe(true);
    expect(matches(s, at('/x/fa'))).toBe(false);
  });

  it('reads a `]` first in a class as a member, negated or not', () => {
    expect(matches(source('.../f[]*]x'), at('/x/f*x'))).toBe(true);
    expect(matches(source('.../f[]*]x'), at('/x/f]x'))).toBe(true);
    expect(matches(source('.../f[]*]x'), at('/x/fax'))).toBe(false);
    expect(matches(source('.../g[^]*]'), at('/x/ga'))).toBe(true);
    expect(matches(source('.../g[^]*]'), at('/x/g*'))).toBe(false);
    expect(matches(source('.../g[^]*]'), at('/x/g]'))).toBe(false);
  });

  it('reads an escaped `]` inside a class as a member', () => {
    const s = source('.../e[\\]*]');
    expect(matches(s, at('/x/e]'))).toBe(true);
    expect(matches(s, at('/x/e*'))).toBe(true);
    expect(matches(s, at('/x/ea'))).toBe(false);
  });

  it('reads a POSIX class inside a class as part of it', () => {
    const s = source('.../p[[:digit:]*]');
    expect(matches(s, at('/x/p5'))).toBe(true);
    expect(matches(s, at('/x/p*'))).toBe(true);
    expect(matches(s, at('/x/pa'))).toBe(false);
  });

  it('reads two POSIX classes in a row inside one class', () => {
    const s = source('.../r[[:alpha:][:digit:]*]');
    expect(matches(s, at('/x/rA'))).toBe(true);
    expect(matches(s, at('/x/r5'))).toBe(true);
    expect(matches(s, at('/x/r*'))).toBe(true);
    expect(matches(s, at('/x/r-'))).toBe(false);
  });

  it('does not take `[:` for a POSIX class when no `:]` follows', () => {
    // The class is `[[:x]`, after an ordinary one.
    const s = source('.../[ab]-[[:x]');
    expect(matches(s, at('/x/a-:'))).toBe(true);
    expect(matches(s, at('/x/b-x'))).toBe(true);
    expect(matches(s, at('/x/c-x'))).toBe(false);
  });

  it('does not take `[:` for a POSIX class when a `]` comes before its `:]`', () => {
    // PCRE's rule: here the class is `[[:a]`, and the `*` after it is the
    // wildcard.
    const s = source('.../q[[:a]*:]');
    expect(matches(s, at('/x/qazz:]'))).toBe(true);
    expect(matches(s, at('/x/q:zz:]'))).toBe(true);
    expect(matches(s, at('/x/qzz:]'))).toBe(false);
  });

  it('gives a wildcard pattern the pattern-stanza default priority, whatever else it contains', () => {
    // The wildcard stanza sorts first in ASCII, so only its default of 0
    // against the literal's 100 puts it second.
    expect(order([source('.../a\\?b'), source('/x/a?b')], at('/x/a?b'))).toEqual([
      'source::/x/a?b',
      'source::.../a\\?b',
    ]);
    expect(order([source('/x/a*'), source('/x/ab')], at('/x/ab'))).toEqual(['source::/x/ab', 'source::/x/a*']);
  });
});

// Issue-derived (#442), beyond the spec: a source pattern is PCRE only when it
// contains `*` or `...`. Without either, Splunk compares it with the source
// exactly as written.
describe('matchStanzas — a source pattern with no wildcard is compared as written (#442)', () => {
  it('reads `?` as a plain character', () => {
    const s = source('/x/nwq.ab?c');
    expect(matches(s, at('/x/nwq.ab?c'))).toBe(true);
    expect(matches(s, at('/x/nwq.ac'))).toBe(false);
    expect(matches(s, at('/x/nwq.abc'))).toBe(false);
  });

  it('reads parentheses, `\\d` and a character class as plain characters', () => {
    expect(matches(source('/x/np(a).log'), at('/x/np(a).log'))).toBe(true);
    expect(matches(source('/x/np(a).log'), at('/x/npa.log'))).toBe(false);
    expect(matches(source('/x/nd\\d.log'), at('/x/nd\\d.log'))).toBe(true);
    expect(matches(source('/x/nd\\d.log'), at('/x/nd5.log'))).toBe(false);
    expect(matches(source('/x/nc[0-9].log'), at('/x/nc[0-9].log'))).toBe(true);
    expect(matches(source('/x/nc[0-9].log'), at('/x/nc5.log'))).toBe(false);
  });
});

// Doc-derived (props.conf.spec, [host::<host>]): host stanzas "match in a
// case-insensitive manner", and "To force a [host::<host>] stanza to match in a
// case-sensitive manner use the "(?-i)" option in its pattern." Issue-derived
// (#442): a host pattern is PCRE whether or not it has a wildcard.
describe('matchStanzas — a host pattern is always PCRE (#442)', () => {
  it('matches case-insensitively', () => {
    expect(matches(host('WEB-HOSTCASE'), onHost('web-hostcase'))).toBe(true);
  });

  it('matches case-sensitively under `(?-i)`', () => {
    expect(matches(host('(?-i)WEB-CS'), onHost('WEB-CS'))).toBe(true);
    expect(matches(host('(?-i)WEB-CS'), onHost('web-cs'))).toBe(false);
  });

  it('reads `?` as a quantifier and `\\d` as a digit, with no wildcard', () => {
    expect(matches(host('web-h?x'), onHost('web-hx'))).toBe(true);
    expect(matches(host('web-h?x'), onHost('web-hax'))).toBe(false);
    expect(matches(host('web-hd\\d'), onHost('web-hd7'))).toBe(true);
    expect(matches(host('web-hd\\d'), onHost('web-hdX'))).toBe(false);
  });

  it('reads `.` as a literal period', () => {
    expect(matches(host('web-h.st'), onHost('web-h.st'))).toBe(true);
    expect(matches(host('web-h.st'), onHost('web-hXst'))).toBe(false);
  });

  it('must match the whole host', () => {
    expect(matches(host('web'), onHost('web01'))).toBe(false);
    expect(matches(host('web...'), onHost('web01'))).toBe(true);
  });

  it('defaults to priority 0 when it uses regex syntax or a wildcard, and 100 otherwise', () => {
    // Each pattern stanza sorts before the literal one in ASCII, so only the
    // defaults put the literal first.
    expect(order([host('web(0)1'), host('web01')], onHost('web01'))).toEqual(['host::web01', 'host::web(0)1']);
    expect(order([host('web...'), host('web01')], onHost('web01'))).toEqual(['host::web01', 'host::web...']);
    expect(order([host('web.0(1)'), host('web.01')], onHost('web.01'))).toEqual(['host::web.01', 'host::web.0(1)']);
  });
});

describe('matchStanzas — a pattern PCRE rejects', () => {
  it('matches nothing, and says why, rather than throwing', () => {
    const s = host('web(01');
    expect(matches(s, onHost('web(01'))).toBe(false);
    const problem = stanzaPatternProblem(s);
    expect(problem?.regex).toBe('web(01');
    expect(problem?.error).toContain('missing closing parenthesis');
    expect(matches(source('/x/app(*.log'), at('/x/app(1.log'))).toBe(false);
    expect(stanzaPatternProblem(source('/x/app(*.log'))?.regex).toBe('/x/app([^/\\\\]*\\.log');
  });

  it('reports an unterminated character class', () => {
    expect(matches(host('web['), onHost('web['))).toBe(false);
    expect(stanzaPatternProblem(host('web['))?.error).toContain('missing terminating ]');
  });

  it('is not rescued by the anchoring group around it', () => {
    // `a)|(b` does not compile; wrapped in a group it would, as `(?:a)|(b)`.
    expect(matches(host('a)|(b'), onHost('a'))).toBe(false);
    expect(stanzaPatternProblem(host('a)|(b'))).not.toBeNull();
  });

  it('is reported by the conf lint, at the stanza, with the regex PCRE was given', () => {
    const props = '[st]\nTRUNCATE = 5\n\n[host::web(01]\nTRUNCATE = 6\n\n[source::/x/*.log]\nTRUNCATE = 7\n';
    const { diagnostics } = runPipeline('x', META, props, '', { perEventPipeline: false, captureOffsets: false });
    const reported = diagnostics.filter((d) => d.message.includes('never matches'));
    expect(reported.map((d) => [d.level, d.file, d.line])).toEqual([['warning', 'props.conf', 4]]);
    expect(reported[0]?.message).toMatch(
      /^\[host::web\(01\] never matches: its pattern reads as the regular expression web\(01, which does not compile \(missing closing parenthesis.*\)\. None of the stanza's settings apply\.$/,
    );
  });

  it('has nothing to report for a pattern that compiles, a literal source, or another kind of stanza', () => {
    expect(stanzaPatternProblem(host('web*'))).toBeNull();
    expect(stanzaPatternProblem(source('/x/app(.log'))).toBeNull();
    expect(stanzaPatternProblem({ ...source('x'), type: 'sourcetype', name: 'web(' })).toBeNull();
    expect(stanzaPatternProblem({ ...source('x'), type: 'default', name: 'default' })).toBeNull();
  });
});

describe('matchStanzas — compiled patterns', () => {
  it('keeps its cache bounded, and recompiles an evicted pattern', () => {
    for (let i = 0; i < 300; i++) expect(matches(source(`.../cache${i}.log`), at(`/x/cache${i}.log`))).toBe(true);
    expect(cachedStanzaPatternCount()).toBe(256);
    expect(matches(source('.../cache0.log'), at('/x/cache0.log'))).toBe(true);
    expect(matches(source('.../cache0.log'), at('/x/cache1.log'))).toBe(false);
  });

  it("gives up a match at Splunk's default MATCH_LIMIT, as a field extraction does", () => {
    // Over eighteen `a`s the first branch backtracks past that limit before it
    // fails. PCRE2's own limit is far higher, and under it the second branch
    // would be reached and match.
    expect(matches(host('(a+)+b|a+'), onHost('a'.repeat(18)))).toBe(false);
    expect(matches(host('(a+)+b|a+'), onHost('a'.repeat(4)))).toBe(true);
  });
});
