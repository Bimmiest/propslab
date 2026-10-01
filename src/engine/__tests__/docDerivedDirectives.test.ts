// ---------------------------------------------------------------------------
// docDerivedDirectives.test.ts
// Simulated directives driven through `runPipeline` from a conf, each asserted
// against what props.conf.spec or transforms.conf.spec says it does.
//
// The processor-level tests assert most of these in more depth with
// hand-built directives. This file is the pipeline-level half: parsing,
// stanza resolution and stage order all sit between the conf and the result,
// and directiveEvidence.test.ts counts the tests here as each directive's
// cited evidence. Every block below names its spec and its directive, and the
// assertions are kept to what the spec states outright.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata, SplunkEvent } from '../types';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
const NOW = Date.parse('2026-01-20T00:00:00Z');

/** Events for one `[st]` stanza body, plus an optional transforms.conf. */
function run(raw: string, body: string, transforms = ''): SplunkEvent[] {
  return runPipeline(raw, META, `[st]\n${body}`, transforms, {
    perEventPipeline: false,
    captureOffsets: false,
    now: NOW,
  }).result.events;
}

const raws = (events: SplunkEvent[]) => events.map((e) => e._raw);
const ONE_PER_LINE = 'SHOULD_LINEMERGE = false\n';

// ---- Line breaking and merging -------------------------------------------

// Doc-derived (props.conf.spec, LINE_BREAKER): the first capturing group marks
// the boundary between events, and its contents are discarded, "not present in
// any event".
describe('LINE_BREAKER through the pipeline', () => {
  it('breaks where the first group matches and discards what it matched', () => {
    expect(raws(run('alpha;;beta;;gamma', `${ONE_PER_LINE}LINE_BREAKER = (;;)\n`))).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// Doc-derived (props.conf.spec, SHOULD_LINEMERGE): when true, several lines are
// combined into one multiline event by the merge rules; when false, nothing is
// merged and each line stays an event.
describe('SHOULD_LINEMERGE through the pipeline', () => {
  const raw = 'START one\ndetail\nSTART two\ndetail';

  it('keeps every line its own event when false', () => {
    expect(run(raw, ONE_PER_LINE)).toHaveLength(4);
  });

  it('merges lines into multiline events when true', () => {
    const events = run(raw, 'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE = ^START\nBREAK_ONLY_BEFORE_DATE = false\n');
    expect(raws(events)).toEqual(['START one\ndetail', 'START two\ndetail']);
  });
});

// Doc-derived (props.conf.spec, BREAK_ONLY_BEFORE): when set, a new event is
// created only at a line that matches the regex; other lines are merged into
// the event before them.
describe('BREAK_ONLY_BEFORE through the pipeline', () => {
  it('starts an event only at a matching line', () => {
    const events = run(
      'BEGIN a\nx\ny\nBEGIN b\nz',
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE = ^BEGIN\nBREAK_ONLY_BEFORE_DATE = false\n',
    );
    expect(raws(events)).toEqual(['BEGIN a\nx\ny', 'BEGIN b\nz']);
  });
});

// Doc-derived (props.conf.spec, BREAK_ONLY_BEFORE_DATE): when true, a new event
// is created only at a line with a date. It is on by default.
describe('BREAK_ONLY_BEFORE_DATE through the pipeline', () => {
  const raw = '2026-01-15 10:00:00 first\ncontinued\n2026-01-15 10:00:01 second\ncontinued';

  it('starts an event only at a dated line', () => {
    const events = run(raw, 'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\n');
    expect(raws(events)).toEqual(['2026-01-15 10:00:00 first\ncontinued', '2026-01-15 10:00:01 second\ncontinued']);
  });

  it('is on by default', () => {
    expect(run(raw, '')).toHaveLength(2);
  });
});

// Doc-derived (props.conf.spec, MUST_BREAK_AFTER): when the regex matches the
// current line, a new event always starts at the next line.
describe('MUST_BREAK_AFTER through the pipeline', () => {
  it('ends the event at the matching line', () => {
    const events = run(
      'BEGIN a\nx\nEND\ny\nBEGIN b',
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE = ^BEGIN\nBREAK_ONLY_BEFORE_DATE = false\nMUST_BREAK_AFTER = ^END\n',
    );
    expect(events[0]?._raw).toBe('BEGIN a\nx\nEND');
    expect(events[1]?._raw.startsWith('y')).toBe(true);
  });
});

// Doc-derived (props.conf.spec, MUST_NOT_BREAK_AFTER): when the current line
// matches, no break happens on any following line until MUST_BREAK_AFTER
// matches.
describe('MUST_NOT_BREAK_AFTER through the pipeline', () => {
  it('holds dated lines together until MUST_BREAK_AFTER matches', () => {
    const events = run(
      '2026-01-15 10:00:00 BEGIN\n2026-01-15 10:00:01 inside\n2026-01-15 10:00:02 END\n2026-01-15 10:00:03 after',
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\nMUST_NOT_BREAK_AFTER = BEGIN\nMUST_BREAK_AFTER = END\n',
    );
    expect(raws(events)).toEqual([
      '2026-01-15 10:00:00 BEGIN\n2026-01-15 10:00:01 inside\n2026-01-15 10:00:02 END',
      '2026-01-15 10:00:03 after',
    ]);
  });
});

// Doc-derived (props.conf.spec, MAX_EVENTS): the maximum number of input lines
// added to any event, after which a break is made; default 256. Only the bound
// is asserted here, not where inside it the break falls.
describe('MAX_EVENTS through the pipeline', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i)}`).join('\n');
  const MERGE_ALL = 'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = false\n';

  it('bounds a merge that would otherwise take every line', () => {
    const events = run(lines(12), `${MERGE_ALL}MAX_EVENTS = 3\n`);
    expect(events.length).toBeGreaterThan(1);
    expect(events.length).toBeLessThan(12);
  });

  it('defaults to 256, so a short input stays one event', () => {
    expect(run(lines(10), MERGE_ALL)).toHaveLength(1);
    expect(run(lines(300), MERGE_ALL).length).toBeGreaterThan(1);
  });
});

// Doc-derived (props.conf.spec, TRUNCATE): the maximum line length in bytes;
// 0 means never truncate.
describe('TRUNCATE through the pipeline', () => {
  const raw = 'abcdefghijklmnopqrstuvwxyz';

  it('cuts a longer line to the limit', () => {
    expect(raws(run(raw, `${ONE_PER_LINE}TRUNCATE = 10\n`))).toEqual(['abcdefghij']);
  });

  it('leaves the line whole at 0', () => {
    expect(raws(run(raw, `${ONE_PER_LINE}TRUNCATE = 0\n`))).toEqual([raw]);
  });
});

// ---- Timestamps -----------------------------------------------------------

const time = (events: SplunkEvent[]) => events[0]?._time?.toISOString();

// Doc-derived (props.conf.spec, MAX_TIMESTAMP_LOOKAHEAD): how many characters
// into the event (from the TIME_PREFIX match, when there is one) to look for a
// timestamp.
describe('MAX_TIMESTAMP_LOOKAHEAD through the pipeline', () => {
  const raw = 'request id 0123456789 at 2026-01-15 10:00:00';
  const body = `${ONE_PER_LINE}TIME_FORMAT = %Y-%m-%d %H:%M:%S\n`;

  it('finds a timestamp inside the window', () => {
    expect(time(run(raw, `${body}MAX_TIMESTAMP_LOOKAHEAD = 64\n`))).toBe('2026-01-15T10:00:00.000Z');
  });

  it('does not find one that starts past it', () => {
    expect(time(run(raw, `${body}MAX_TIMESTAMP_LOOKAHEAD = 10\n`))).not.toBe('2026-01-15T10:00:00.000Z');
  });
});

// Doc-derived (props.conf.spec, TZ): a zone written in the event wins; failing
// that, TZ names the zone the timestamp is read in.
describe('TZ through the pipeline', () => {
  it('reads a zoneless timestamp in the TZ zone', () => {
    const events = run(
      '2026-01-15 10:00:00 x',
      `${ONE_PER_LINE}TIME_FORMAT = %Y-%m-%d %H:%M:%S\nTZ = America/New_York\n`,
    );
    expect(time(events)).toBe('2026-01-15T15:00:00.000Z');
  });

  it('leaves a timestamp that carries its own offset alone', () => {
    const events = run(
      '2026-01-15 10:00:00 +0000 x',
      `${ONE_PER_LINE}TIME_FORMAT = %Y-%m-%d %H:%M:%S %z\nTZ = America/New_York\n`,
    );
    expect(time(events)).toBe('2026-01-15T10:00:00.000Z');
  });
});

// ---- Index-time rewriting -------------------------------------------------

// Doc-derived (props.conf.spec, SEDCMD): `s/regex/replacement/flags` replaces
// the match, every match with the `g` flag; `y/string1/string2/` substitutes
// each character of string1 with the character at the same position in
// string2.
describe('SEDCMD through the pipeline', () => {
  it('replaces every match with the g flag', () => {
    const events = run(
      'ssn=123-45-6789 alt=987-65-4321',
      `${ONE_PER_LINE}SEDCMD-mask = s/\\d{3}-\\d{2}-\\d{4}/XXX/g\n`,
    );
    expect(raws(events)).toEqual(['ssn=XXX alt=XXX']);
  });

  it('transliterates character by character with y', () => {
    expect(raws(run('cab', `${ONE_PER_LINE}SEDCMD-tr = y/abc/xyz/\n`))).toEqual(['zxy']);
  });
});

// ---- Search-time extraction -----------------------------------------------

const fields = (events: SplunkEvent[]) => events[0]?.fields ?? {};

// Doc-derived (props.conf.spec, EXTRACT): each named capturing group in the
// regex becomes a field, named for the group, with the group's value.
describe('EXTRACT through the pipeline', () => {
  it('makes a field from each named group', () => {
    const f = fields(
      run('user=alice action=login', `${ONE_PER_LINE}EXTRACT-ua = user=(?<user>\\w+) action=(?<act>\\w+)\n`),
    );
    expect(f['user']).toBe('alice');
    expect(f['act']).toBe('login');
  });
});

// Doc-derived (props.conf.spec, FIELDALIAS): `<orig_field_name> AS
// <new_field_name>` adds an alias; the original field is not removed.
describe('FIELDALIAS through the pipeline', () => {
  it('copies the field under the new name and keeps the original', () => {
    const f = fields(
      run('user=alice', `${ONE_PER_LINE}EXTRACT-u = user=(?<user>\\w+)\nFIELDALIAS-u = user AS username\n`),
    );
    expect(f['username']).toBe('alice');
    expect(f['user']).toBe('alice');
  });
});

// Doc-derived (props.conf.spec, FIELDALIAS): with AS, "If the <orig_field_name>
// field has no value or does not exist, the <new_field_name> is removed"; with
// ASNEW, "If the <orig_field_name> field has no value or does not exist, the
// <new_field_name> is kept" (#445). Automatic key/value extraction supplies
// `src`; nothing supplies `src_ip`.
describe('FIELDALIAS through the pipeline, when the original field does not exist', () => {
  const raw = '2026-01-15T10:00:00Z src=1.2.3.4 action=allowed';

  it('removes the new field with AS', () => {
    const f = fields(run(raw, `${ONE_PER_LINE}FIELDALIAS-x = src_ip AS src\n`));
    expect(f['src']).toBeUndefined();
    expect(f['action']).toBe('allowed');
  });

  it('keeps the new field with ASNEW', () => {
    const f = fields(run(raw, `${ONE_PER_LINE}FIELDALIAS-x = src_ip ASNEW src\n`));
    expect(f['src']).toBe('1.2.3.4');
  });
});

// Doc-derived (props.conf.spec, EVAL): the eval statement is run and its value
// assigned to the field the directive names, a calculated field.
describe('EVAL through the pipeline', () => {
  it('assigns the value of the expression to the named field', () => {
    const f = fields(run('n=4', `${ONE_PER_LINE}EXTRACT-n = n=(?<n>\\d+)\nEVAL-doubled = n * 2\n`));
    expect(f['doubled']).toBe('8');
  });
});

// Doc-derived (props.conf.spec, AUTO_KV_JSON): whether search-time extraction
// tries JSON automatically; default true.
describe('AUTO_KV_JSON through the pipeline', () => {
  const raw = '{"user":"alice","status":200}';

  it('extracts JSON keys by default', () => {
    expect(fields(run(raw, ONE_PER_LINE))['user']).toBe('alice');
  });

  it('does not when set to false', () => {
    expect(fields(run(raw, `${ONE_PER_LINE}AUTO_KV_JSON = false\n`))['user']).toBeUndefined();
  });
});

// ---- Structured data: INDEXED_EXTRACTIONS = csv ---------------------------

const csv = (raw: string, extra = '') => run(raw, `INDEXED_EXTRACTIONS = csv\n${extra}`);

// Doc-derived (props.conf.spec, FIELD_DELIMITER): the character that separates
// fields in structured data.
describe('FIELD_DELIMITER through the pipeline', () => {
  it('splits on the named character', () => {
    expect(fields(csv('a;b\n1;2', 'FIELD_DELIMITER = ;\n'))).toMatchObject({ a: '1', b: '2' });
  });
});

// Doc-derived (props.conf.spec, FIELD_QUOTE): the character that quotes a field
// in structured data, so a delimiter inside it does not split it.
describe('FIELD_QUOTE through the pipeline', () => {
  it("keeps a delimiter inside the quote character's quotes", () => {
    expect(fields(csv("name,msg\nbob,'hi, there'", "FIELD_QUOTE = '\n"))).toMatchObject({
      name: 'bob',
      msg: 'hi, there',
    });
  });
});

// Doc-derived (props.conf.spec, FIELD_NAMES): for structured files with no
// header, names the fields directly.
describe('FIELD_NAMES through the pipeline', () => {
  it('names the columns of a headerless file', () => {
    const events = csv('1,2\n3,4', 'FIELD_NAMES = x,y\n');
    expect(events.map((e) => [e.fields['x'], e.fields['y']])).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});

// Doc-derived (props.conf.spec, HEADER_FIELD_LINE_NUMBER): the line number of
// the line holding the header fields.
describe('HEADER_FIELD_LINE_NUMBER through the pipeline', () => {
  it('reads the header from the named line', () => {
    const events = csv('exported by tool\na,b\n1,2', 'HEADER_FIELD_LINE_NUMBER = 2\n');
    expect(events.map((e) => e.fields)).toEqual([expect.objectContaining({ a: '1', b: '2' })]);
  });
});

// Doc-derived (props.conf.spec, PREAMBLE_REGEX): lines matching it are preamble,
// and are ignored.
describe('PREAMBLE_REGEX through the pipeline', () => {
  it('skips the matching lines before the header', () => {
    const events = csv('# generated 2026\n# by tool\na,b\n1,2', 'PREAMBLE_REGEX = ^#\n');
    expect(events.map((e) => e.fields)).toEqual([expect.objectContaining({ a: '1', b: '2' })]);
  });
});

// Doc-derived (props.conf.spec, TIMESTAMP_FIELDS): names the field or fields
// that hold the timestamp in structured data.
describe('TIMESTAMP_FIELDS through the pipeline', () => {
  it('takes _time from the named field', () => {
    const events = csv('msg,when\nhello,2026-01-15T10:00:00Z', 'TIMESTAMP_FIELDS = when\n');
    expect(time(events)).toBe('2026-01-15T10:00:00.000Z');
  });
});

// ---- transforms.conf ------------------------------------------------------

// KV_MODE = none throughout, so automatic key/value extraction cannot supply a
// field the transform under test did not.
const NO_AUTO_KV = `${ONE_PER_LINE}KV_MODE = none\n`;

const report = (raw: string, transforms: string, extraProps = '') =>
  fields(run(raw, `${NO_AUTO_KV}${extraProps}REPORT-t = t\n`, transforms));

// Doc-derived (transforms.conf.spec, REGEX): at search time, each named
// capturing group in REGEX is extracted as a field.
describe('REGEX through the pipeline', () => {
  it('extracts named groups through a REPORT', () => {
    expect(report('user=alice', '[t]\nREGEX = user=(?<user>\\w+)\n')['user']).toBe('alice');
  });
});

// Doc-derived (transforms.conf.spec, DELIMS): the first set of delimiters
// separates the pairs, the second separates each field name from its value.
describe('DELIMS through the pipeline', () => {
  it('splits pairs, then name from value', () => {
    expect(report('a=1&b=2', '[t]\nDELIMS = "&", "="\n')).toMatchObject({ a: '1', b: '2' });
  });
});

// Doc-derived (transforms.conf.spec, FIELDS): with DELIMS, names the values
// extracted, in the order they are extracted.
describe('FIELDS through the pipeline', () => {
  it('names delimited values in order', () => {
    expect(report('x,y', '[t]\nDELIMS = ","\nFIELDS = "first", "second"\n')).toMatchObject({
      first: 'x',
      second: 'y',
    });
  });
});

// Doc-derived (transforms.conf.spec, SOURCE_KEY): at search time it can name a
// field, and REGEX then runs against that field's value instead of _raw.
// props.conf.spec puts EXTRACT before REPORT in the search-time order, so an
// EXTRACT can supply the field.
describe('SOURCE_KEY through the pipeline', () => {
  it('runs the REGEX on the named field', () => {
    const f = report(
      'path=/var/log/app.log file=ignored',
      '[t]\nSOURCE_KEY = path\nREGEX = /(?<basename>[^/]+)$\n',
      'EXTRACT-p = path=(?<path>\\S+)\n',
    );
    expect(f['basename']).toBe('app.log');
  });
});

// Doc-derived (transforms.conf.spec, MV_ADD): when the extractor finds a field
// that already exists, true appends the new value as a multivalue; otherwise
// the new value is discarded. Default false.
describe('MV_ADD through the pipeline', () => {
  const t = (mvAdd: string) => `[t]\nREGEX = n=(?<n>\\d+)\nMV_ADD = ${mvAdd}\n`;

  it('appends a value found again when true', () => {
    expect(report('n=1 n=2', t('true'))['n']).toEqual(['1', '2']);
  });

  it('discards it when false', () => {
    expect(report('n=1 n=2', t('false'))['n']).toBe('1');
  });
});

// Doc-derived (transforms.conf.spec, CLEAN_KEYS): extracted keys have
// non-alphanumeric characters replaced with underscores, and leading
// underscores and digits removed; default true.
describe('CLEAN_KEYS through the pipeline', () => {
  const pairs = '[t]\nREGEX = (\\S+)=(\\S+)\nFORMAT = $1::$2\n';

  it('cleans keys by default', () => {
    const f = report('my-key=v', pairs);
    expect(f['my_key']).toBe('v');
    expect(f['my-key']).toBeUndefined();
  });

  it('strips leading underscores and digits', () => {
    expect(report('_9lives=v', pairs)['lives']).toBe('v');
  });

  it('keeps the key as written when false', () => {
    expect(report('my-key=v', `${pairs}CLEAN_KEYS = false\n`)['my-key']).toBe('v');
  });
});

// Doc-derived (transforms.conf.spec, KEEP_EMPTY_VALS): whether a pair whose
// value is an empty string is kept; default false. Only the default is
// asserted here.
describe('KEEP_EMPTY_VALS through the pipeline', () => {
  const delims = '[t]\nDELIMS = " ", "="\n';

  it.each([
    ['unset', delims],
    ['false', `${delims}KEEP_EMPTY_VALS = false\n`],
  ])('drops an empty value when %s', (_, transforms) => {
    const f = report('a= b=2', transforms);
    expect(f['b']).toBe('2');
    expect(f['a']).toBeUndefined();
  });
});

// ---- Index-time transforms ------------------------------------------------

const indexTime = (raw: string, transforms: string) => run(raw, `${NO_AUTO_KV}TRANSFORMS-t = t\n`, transforms)[0];

// Doc-derived (transforms.conf.spec, WRITE_META): when true, the values the
// REGEX extracts are written to _meta, as index-time fields.
describe('WRITE_META through the pipeline', () => {
  it('writes the FORMAT pairs as indexed fields', () => {
    const e = indexTime('user=alice', '[t]\nREGEX = user=(\\w+)\nFORMAT = user::$1\nWRITE_META = true\n');
    expect(e?.fields['user'] ?? e?._meta['user']).toBe('alice');
  });
});

// Doc-derived (transforms.conf.spec, REPEAT_MATCH): runs the REGEX again from
// where the last match stopped until it finds no more; only valid at index
// time, default false.
describe('REPEAT_MATCH through the pipeline', () => {
  const t = (repeat: string) =>
    `[t]\nREGEX = (\\w+)=(\\d+)\nFORMAT = $1::$2\nWRITE_META = true\nREPEAT_MATCH = ${repeat}\n`;
  const indexed = (e: SplunkEvent | undefined, k: string) => e?.fields[k] ?? e?._meta[k];

  it('matches once by default', () => {
    const e = indexTime('a=1 b=2', t('false'));
    expect(indexed(e, 'a')).toBe('1');
    expect(indexed(e, 'b')).toBeUndefined();
  });

  it('keeps matching when true', () => {
    const e = indexTime('a=1 b=2', t('true'));
    expect(indexed(e, 'a')).toBe('1');
    expect(indexed(e, 'b')).toBe('2');
  });
});

// Doc-derived (transforms.conf.spec, DEFAULT_VALUE): written to DEST_KEY when
// the REGEX does not match.
describe('DEFAULT_VALUE through the pipeline', () => {
  it('routes by the default when the REGEX fails', () => {
    const e = indexTime(
      'nothing to see',
      '[t]\nREGEX = never-matches\nDEST_KEY = MetaData:Sourcetype\nFORMAT = sourcetype::matched\nDEFAULT_VALUE = sourcetype::fallback\n',
    );
    expect(e?.metadata.sourcetype).toBe('fallback');
  });
});

// Doc-derived (transforms.conf.spec, LOOKAHEAD): how many characters into the
// event the REGEX searches; default 4096.
describe('LOOKAHEAD through the pipeline', () => {
  const t = (lookahead: string) =>
    `[t]\nREGEX = user=(\\w+)\nFORMAT = user::$1\nWRITE_META = true\nLOOKAHEAD = ${lookahead}\n`;
  const raw = `${'x'.repeat(40)} user=alice`;
  const indexed = (e: SplunkEvent | undefined) => e?.fields['user'] ?? e?._meta['user'];

  it('finds a match inside the window', () => {
    expect(indexed(indexTime(raw, t('100')))).toBe('alice');
  });

  it('does not find one past it', () => {
    expect(indexed(indexTime(raw, t('20')))).toBeUndefined();
  });
});
