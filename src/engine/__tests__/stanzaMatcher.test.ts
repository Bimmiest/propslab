import { describe, it, expect } from 'vitest';
import { matchStanzas, mergeDirectives } from '../parser/stanzaMatcher';
import { parseConf } from '../parser/confParser';
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

describe('matchStanzas — host case-insensitivity without the `i` flag (#118)', () => {
  // `host::` matching is case-insensitive in Splunk. It is implemented by
  // lower-casing both sides rather than compiling with `i`, because V8's
  // linear-time regex fallback cannot compile a pattern carrying `d`, `i` or
  // `u`, and this runs per event. These tests pin the BEHAVIOUR so the
  // implementation stays free to keep the regex fallback-eligible.
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
// 'or'. `( )` are used to limit scope of `|`."
describe('matchStanzas — `|` alternation and `( )` scoping (#284)', () => {
  it('matches either branch of a scoped alternation', () => {
    const s = source('/var/log/(messages|secure)');
    expect(matchStanzas([s], at('/var/log/secure'))).toHaveLength(1);
    expect(matchStanzas([s], at('/var/log/messages'))).toHaveLength(1);
  });

  it('does not match outside the alternatives, or the pattern text itself', () => {
    const s = source('/var/log/(messages|secure)');
    expect(matchStanzas([s], at('/var/log/maillog'))).toHaveLength(0);
    expect(matchStanzas([s], at('/var/log/(messages|secure)'))).toHaveLength(0);
  });

  it('anchors a top-level alternation at both ends', () => {
    // Without a wrapping group, `^a|b$` would accept anything starting with
    // the first branch or ending with the second.
    const s = source('/var/log/messages|/var/log/secure');
    expect(matchStanzas([s], at('/var/log/secure'))).toHaveLength(1);
    expect(matchStanzas([s], at('/var/log/messages.1'))).toHaveLength(0);
    expect(matchStanzas([s], at('/tmp/var/log/secure'))).toHaveLength(0);
  });

  it('keeps wildcards working inside a group', () => {
    const s = source('/var/log/(app|web)/*.log');
    expect(matchStanzas([s], at('/var/log/web/access.log'))).toHaveLength(1);
    expect(matchStanzas([s], at('/var/log/web/sub/access.log'))).toHaveLength(0);
    expect(matchStanzas([source('/var/(...|tmp)/x')], at('/var/a/b/x'))).toHaveLength(1);
  });

  it('reads an unbalanced parenthesis as a literal character rather than throwing', () => {
    expect(matchStanzas([source('/var/log/app(1.log')], at('/var/log/app(1.log'))).toHaveLength(1);
    expect(matchStanzas([source('/var/log/app1).log')], at('/var/log/app1).log'))).toHaveLength(1);
    // The outer `(` has no partner; the inner pair still groups.
    expect(matchStanzas([source('/x/((a|b)')], at('/x/(b'))).toHaveLength(1);
  });

  it('gives an alternation pattern the pattern-stanza default priority', () => {
    // A literal source stanza defaults to 100 and a pattern one to 0, so the
    // literal wins even when listed second.
    const alt = source('/var/log/(messages|secure)');
    const literal = source('/var/log/secure');
    expect(matchStanzas([alt, literal], at('/var/log/secure')).map((s) => s.name)).toEqual([
      'source::/var/log/secure',
      'source::/var/log/(messages|secure)',
    ]);
  });
});

// Doc-derived (props.conf.spec, stanza pattern syntax): "\\ = matches a literal
// backslash '\'".
describe('matchStanzas — a doubled backslash matches one literal backslash (#303)', () => {
  // The conf text `C:\\logs\\app.log`, i.e. written the way the spec says.
  const SPEC_WINDOWS = 'C:\\\\logs\\\\app.log';

  it('matches a Windows path written per the spec', () => {
    expect(matchStanzas([source(SPEC_WINDOWS)], at('C:\\logs\\app.log'))).toHaveLength(1);
  });

  it('no longer demands two backslashes where the spec means one', () => {
    expect(matchStanzas([source(SPEC_WINDOWS)], at('C:\\\\logs\\\\app.log'))).toHaveLength(0);
  });

  it('still reads a lone backslash as itself, so existing configs keep matching', () => {
    expect(matchStanzas([source('C:\\logs\\app.log')], at('C:\\logs\\app.log'))).toHaveLength(1);
  });

  it('pairs backslashes left to right, leaving an odd one literal', () => {
    // `\\\` is an escaped backslash followed by a lone one: two in total.
    expect(matchStanzas([source('a\\\\\\b')], at('a\\\\b'))).toHaveLength(1);
    // `\\\\` is two escaped backslashes: also two.
    expect(matchStanzas([source('a\\\\\\\\b')], at('a\\\\b'))).toHaveLength(1);
  });

  it('keeps wildcards working after an escaped backslash', () => {
    const s = source('C:\\\\logs\\\\*.log');
    expect(matchStanzas([s], at('C:\\logs\\app.log'))).toHaveLength(1);
    // `*` stops at a path separator, and a backslash is one.
    expect(matchStanzas([s], at('C:\\logs\\sub\\app.log'))).toHaveLength(0);
  });

  it('is still a literal-matching stanza, with the default priority that implies', () => {
    const wild = source('C:\\\\logs\\\\*');
    expect(matchStanzas([wild, source(SPEC_WINDOWS)], at('C:\\logs\\app.log')).map((s) => s.name)).toEqual([
      `source::${SPEC_WINDOWS}`,
      'source::C:\\\\logs\\\\*',
    ]);
  });

  it('survives the conf parser: the stanza header keeps its backslashes', () => {
    const conf = parseConf('[source::C:\\\\logs\\\\app.log]\nTRUNCATE = 5\n', 'props.conf');
    expect(matchStanzas(conf.stanzas, at('C:\\logs\\app.log'))).toHaveLength(1);
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
