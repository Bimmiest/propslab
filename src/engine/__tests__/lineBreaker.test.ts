import { describe, it, expect } from 'vitest';
import { breakLines } from '../processors/lineBreaker';
import type { ConfDirective, EventMetadata, ValidationDiagnostic } from '../types';
import { runCtx } from './runCtx';

const META: EventMetadata = { index: 'main', host: 'host1', source: '/var/log/app.log', sourcetype: 'myapp' };

function dir(key: string, value: string): ConfDirective {
  return { key, value, line: 1, directiveType: key };
}

describe('breakLines — basic LINE_BREAKER', () => {
  it('splits on newlines by default', () => {
    const events = breakLines('line1\nline2\nline3', [], META, runCtx());
    // SHOULD_LINEMERGE=true + BREAK_ONLY_BEFORE_DATE=true (default)
    // None of the lines look like dates, so they all merge into one event
    expect(events).toHaveLength(1);
    expect(events[0]!._raw).toContain('line1');
  });

  it('preserves events when SHOULD_LINEMERGE=false', () => {
    const events = breakLines('line1\nline2\nline3', [dir('SHOULD_LINEMERGE', 'false')], META, runCtx());
    expect(events).toHaveLength(3);
    expect(events[0]!._raw).toBe('line1');
    expect(events[1]!._raw).toBe('line2');
    expect(events[2]!._raw).toBe('line3');
  });
});

describe('breakLines — MAX_EVENTS line cap (SEM-5)', () => {
  it('caps a merged event at MAX_EVENTS *continuation* lines', () => {
    // Date-less lines would all merge into one event by default. MAX_EVENTS
    // bounds the continuation lines merged in, not the event's total line
    // count, so MAX_EVENTS=3 yields four-line events -- pinned by the Splunk
    // 10.4.0 capture `linebreak-max-events`.
    const raw = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n');
    const events = breakLines(raw, [dir('MAX_EVENTS', '3')], META, runCtx());
    expect(events).toHaveLength(3);
    expect(events[0]!._raw.split('\n')).toHaveLength(4);
  });

  it('defaults to 256 lines (no cap for small inputs)', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const events = breakLines(raw, [], META, runCtx());
    expect(events).toHaveLength(1);
  });

  it('ignores a non-numeric MAX_EVENTS (falls back to default)', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const events = breakLines(raw, [dir('MAX_EVENTS', 'abc')], META, runCtx());
    expect(events).toHaveLength(1);
  });
});

describe('breakLines — SHOULD_LINEMERGE defaults', () => {
  it('BREAK_ONLY_BEFORE_DATE defaults to true — breaks before ISO timestamp lines', () => {
    const raw = '2024-01-15 first event\ncontinuation of first\n2024-01-16 second event\n';
    const events = breakLines(raw, [], META, runCtx());
    expect(events).toHaveLength(2);
    expect(events[0]!._raw).toContain('first event');
    expect(events[0]!._raw).toContain('continuation');
    expect(events[1]!._raw).toContain('second event');
  });

  it('does NOT merge everything into one event by default', () => {
    const raw = '2024-01-15 event1\n2024-01-16 event2\n2024-01-17 event3\n';
    const events = breakLines(raw, [], META, runCtx());
    expect(events.length).toBeGreaterThan(1);
  });

  it('BREAK_ONLY_BEFORE_DATE=false merges non-timestamp lines into one event', () => {
    const raw = 'line1\nline2\nline3\n';
    const events = breakLines(raw, [dir('BREAK_ONLY_BEFORE_DATE', 'false')], META, runCtx());
    expect(events).toHaveLength(1);
  });
});

// Doc-derived (props.conf.spec, BREAK_ONLY_BEFORE_DATE: "creates a new event
// only if it encounters a new line with a date", recognised the way timestamps
// are — within MAX_TIMESTAMP_LOOKAHEAD). Not a captured fixture.
describe('#287 — BREAK_ONLY_BEFORE_DATE finds a date anywhere in the lookahead window', () => {
  const raws = (raw: string, extra: ConfDirective[] = []) =>
    breakLines(raw, extra, META, runCtx()).map((e) => e._raw);

  it('breaks before a bracketed timestamp', () => {
    expect(raws('[2026-09-22 10:00:00] a\ncont\n[2026-09-22 10:00:01] b')).toEqual([
      '[2026-09-22 10:00:00] a\ncont',
      '[2026-09-22 10:00:01] b',
    ]);
  });

  it('breaks before a syslog line behind its priority', () => {
    expect(raws('<34>Sep 22 10:00:01 host a\ncont\n<34>Sep 22 10:00:02 host c')).toEqual([
      '<34>Sep 22 10:00:01 host a\ncont',
      '<34>Sep 22 10:00:02 host c',
    ]);
  });

  it('breaks before an access-log line whose date follows the client address', () => {
    const raw =
      '10.0.0.1 - - [22/Sep/2026:10:00:00 +0000] "GET / HTTP/1.1" 200\n' +
      '10.0.0.2 - - [22/Sep/2026:10:00:01 +0000] "GET /a HTTP/1.1" 200';
    expect(raws(raw)).toHaveLength(2);
  });

  it('ignores a date past MAX_TIMESTAMP_LOOKAHEAD', () => {
    const raw = '2026-09-22 10:00:00 a\n' + 'x'.repeat(40) + ' 2026-09-22 late';
    expect(raws(raw)).toHaveLength(2);
    expect(raws(raw, [dir('MAX_TIMESTAMP_LOOKAHEAD', '20')])).toHaveLength(1);
  });

  // Doc-derived (props.conf.spec, MAX_TIMESTAMP_LOOKAHEAD: "Set to 0 or -1 to
  // disable the lookahead limit"), read the way timestampExtractor reads it.
  it.each(['0', '-1'])('searches the whole line when MAX_TIMESTAMP_LOOKAHEAD = %s', (value) => {
    const raw = '2026-09-22 10:00:00 a\n' + 'x'.repeat(200) + ' 2026-09-22 late';
    expect(raws(raw)).toHaveLength(1);
    expect(raws(raw, [dir('MAX_TIMESTAMP_LOOKAHEAD', value)])).toHaveLength(2);
  });

  it('does not read a month name inside a word as a date', () => {
    expect(raws('2026-09-22 a\nMarket 5 closed\nDecimal 12 places')).toHaveLength(1);
  });

  it('does not read a date inside a longer number', () => {
    expect(raws('2026-09-22 a\nid 120260922-01-15\nref 3/4/2026/7')).toHaveLength(1);
  });

  it('accepts a plausible epoch at the start of a line', () => {
    expect(raws('1768471200 a\ncont\n1768471200123 b\n1768471200.5 c')).toEqual([
      '1768471200 a\ncont',
      '1768471200123 b',
      '1768471200.5 c',
    ]);
  });

  it('does not treat any 10–13 digit run as an epoch', () => {
    // An 11- or 12-digit id, a 10-digit number that is not a plausible epoch,
    // and an epoch glued to other text all stay continuation lines.
    expect(raws('1768471200 a\n17684712001 b\n176847120012 c\n9999999999 d\nid-1768471200 e')).toHaveLength(1);
  });

  // Doc-derived: datetime.xml reads a UTC epoch after whitespace or one of
  // # , " = ( [ | {, not only at the start of a line.
  it('accepts a plausible epoch after a delimiter in mid-line', () => {
    expect(raws('1768471200 a\ntime=1768471201 b\n[1768471202] c\nid 1768471203 d')).toHaveLength(4);
  });
});

describe('breakLines — BREAK_ONLY_BEFORE', () => {
  it('breaks only when the next segment matches the pattern', () => {
    const raw = 'START event1\ncontinuation\nSTART event2\ncontinuation2\n';
    const events = breakLines(raw, [dir('BREAK_ONLY_BEFORE', '^START')], META, runCtx());
    expect(events).toHaveLength(2);
    expect(events[0]!._raw).toContain('continuation');
    expect(events[1]!._raw).toContain('continuation2');
  });

  // Checked on Splunk 10.4.0, not doc-derived (#323). The stanza below, with
  // this input sent through receivers/simple, produced these four events:
  // the pattern is searched for anywhere in a line, and the event starts at
  // the beginning of the matching line, leading whitespace and all.
  it('breaks before a line that matches anywhere, not only at its start', () => {
    const raw = 'EVENT 1 starts here\ncontinuation of 1\na EVENT 2 is mid-line\ncontinuation of 2\n  EVENT 3 after two spaces\nEVENT 4 starts here\n';
    const events = breakLines(raw, [
      dir('SHOULD_LINEMERGE', 'true'),
      dir('BREAK_ONLY_BEFORE', 'EVENT'),
      dir('BREAK_ONLY_BEFORE_DATE', 'false'),
      dir('DATETIME_CONFIG', 'CURRENT'),
    ], META, runCtx());
    expect(events.map((e) => e._raw)).toEqual([
      'EVENT 1 starts here\ncontinuation of 1',
      'a EVENT 2 is mid-line\ncontinuation of 2',
      '  EVENT 3 after two spaces',
      'EVENT 4 starts here',
    ]);
  });
});

describe('breakLines — custom LINE_BREAKER', () => {
  it('splits on a custom separator pattern', () => {
    // Separator pattern with a capturing group
    const raw = 'event1---event2---event3';
    const events = breakLines(raw, [
      dir('LINE_BREAKER', '(---)'),
      dir('SHOULD_LINEMERGE', 'false'),
    ], META, runCtx());
    expect(events).toHaveLength(3);
    expect(events[0]!._raw).toBe('event1');
    expect(events[1]!._raw).toBe('event2');
    expect(events[2]!._raw).toBe('event3');
  });

  it('uses d-flag indices correctly when separator repeats within the match', () => {
    // Pattern where m[1] repeats: separator is a run of dashes, but the full
    // match includes surrounding context. Use a pattern where the captured
    // group content appears earlier in m[0] to expose the indexOf bug.
    const raw = 'aXXbXXc';
    const events = breakLines(raw, [
      dir('LINE_BREAKER', 'a(XX)'),
      dir('SHOULD_LINEMERGE', 'false'),
    ], META, runCtx());
    // "a" before the capture group belongs to the first (empty) segment,
    // "bXXc" is the rest. We care that the split is not off by the repeated "XX".
    expect(events.some((e) => e._raw === 'bXXc')).toBe(true);
  });
});

// Doc-derived (props.conf.spec, LINE_BREAKER): "the start of the first
// capturing group [is] the end of the previous line" and its end "the start of
// the next line" — so an empty group breaks WITHOUT removing anything, and a
// break at the very start of the current event ends no event at all.
describe('#283 — zero-width LINE_BREAKER captures', () => {
  it('breaks before each lookahead match, keeping every character', () => {
    const events = breakLines('a\nbcd\nbxy', [
      dir('LINE_BREAKER', '()(?=b)'),
      dir('SHOULD_LINEMERGE', 'false'),
    ], META, runCtx());
    // Was ['a\n', 'b', 'cd\n', 'b', 'xy']: the empty match at the start of
    // each new event re-fired, and the loop guard emitted one character alone.
    expect(events.map((e) => e._raw)).toEqual(['a\n', 'bcd\n', 'bxy']);
  });

  it('does not produce an empty or one-character event at the start of input', () => {
    const events = breakLines('bxy\nbz', [
      dir('LINE_BREAKER', '()(?=b)'),
      dir('SHOULD_LINEMERGE', 'false'),
    ], META, runCtx());
    expect(events.map((e) => e._raw)).toEqual(['bxy\n', 'bz']);
  });

  it('records each event at its real offset in the input', () => {
    const events = breakLines('a\nbcd\nbxy', [
      dir('LINE_BREAKER', '()(?=b)'),
      dir('SHOULD_LINEMERGE', 'false'),
    ], META, runCtx());
    expect(events.map((e) => e.lineNumbers.start)).toEqual([1, 2, 3]);
  });

  it('lets a lookbehind see text the previous break consumed', () => {
    // A blank-line separator written with a lookbehind: the run of newlines
    // after the first is the separator. The lookbehind must see the newline
    // just consumed, or a newline leaks into the second event.
    const events = breakLines('a\n\n\nb', [
      dir('LINE_BREAKER', '(?<=\\n)(\\n)'),
      dir('SHOULD_LINEMERGE', 'false'),
    ], META, runCtx());
    expect(events.map((e) => e._raw)).toEqual(['a\n', 'b']);
  });
});

describe('breakLines — uncompilable break patterns are reported (#75.2)', () => {
  it('warns when BREAK_ONLY_BEFORE cannot be compiled', () => {
    const diags: ValidationDiagnostic[] = [];
    breakLines('a\nb\nc', [dir('BREAK_ONLY_BEFORE', '(a+')], META, runCtx(diags));
    const warning = diags.find((d) => d.message.includes('BREAK_ONLY_BEFORE'));
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('does not compile (missing closing parenthesis');
  });

  it('warns when MUST_BREAK_AFTER cannot be compiled', () => {
    const diags: ValidationDiagnostic[] = [];
    breakLines('a\nb\nc', [dir('MUST_BREAK_AFTER', '[unterminated')], META, runCtx(diags));
    expect(diags.some((d) => d.message.includes('MUST_BREAK_AFTER'))).toBe(true);
  });

  it('stays quiet for a pattern that compiles', () => {
    const diags: ValidationDiagnostic[] = [];
    breakLines('a\nb\nc', [dir('BREAK_ONLY_BEFORE', '^\\d{4}-')], META, runCtx(diags));
    expect(diags.filter((d) => d.message.includes('BREAK_ONLY_BEFORE'))).toHaveLength(0);
  });

  it('stays quiet when the directive is absent', () => {
    const diags: ValidationDiagnostic[] = [];
    breakLines('a\nb\nc', [], META, runCtx(diags));
    expect(diags.filter((d) => d.message.includes('BREAK_ONLY_BEFORE'))).toHaveLength(0);
  });
});

describe('#172 — a LINE_BREAKER with no capture group', () => {
  it('falls back to breaking on newlines, leaving the delimiter as its own event', () => {
    const raw = '2026-01-15T10:00:00Z one\n-----\n2026-01-15T10:00:01Z two\n';
    const events = breakLines(raw, [dir('SHOULD_LINEMERGE', 'false'), dir('LINE_BREAKER', '-----')], META, runCtx());
    expect(events.map((e) => e._raw)).toEqual([
      '2026-01-15T10:00:00Z one',
      '-----',
      '2026-01-15T10:00:01Z two',
    ]);
  });

  it('leaves no trailing newline in _raw', () => {
    const events = breakLines('a\nb\n', [dir('SHOULD_LINEMERGE', 'false'), dir('LINE_BREAKER', 'X')], META, runCtx());
    expect(events.every((e) => !e._raw.endsWith('\n'))).toBe(true);
  });

  it('says why, rather than silently ignoring the pattern', () => {
    const diags: ValidationDiagnostic[] = [];
    breakLines('a\nb\n', [dir('LINE_BREAKER', '-----')], META, runCtx(diags));
    expect(diags.some((d) => d.message.includes('no capturing group'))).toBe(true);
  });

  it('still honours a pattern that does have a group', () => {
    const events = breakLines('a-----b', [dir('SHOULD_LINEMERGE', 'false'), dir('LINE_BREAKER', '(-----)')], META, runCtx());
    expect(events.map((e) => e._raw)).toEqual(['a', 'b']);
  });
});

describe('#472 — a LINE_BREAKER that does not compile', () => {
  // Doc-derived: props.conf.spec says LINE_BREAKER is a regular expression, and
  // a regular expression that is not valid PCRE cannot name a break. The
  // simulator breaks on newlines then; the point of these tests is the message.
  it('reports its compile error, not a missing capture group', () => {
    const diags: ValidationDiagnostic[] = [];
    const events = breakLines('a\nb\n', [
      dir('SHOULD_LINEMERGE', 'false'),
      dir('LINE_BREAKER', '([\\r\\n]+'),
    ], META, runCtx(diags));
    const lb = diags.filter((d) => d.directiveKey === 'LINE_BREAKER');
    expect(lb).toHaveLength(1);
    expect(lb[0]!.message).toContain('does not compile (missing closing parenthesis');
    expect(lb[0]!.message).not.toContain('no capturing group');
    expect(lb[0]!.message).not.toContain('Wrap the delimiter');
    // Events are still broken, on newlines.
    expect(events.map((e) => e._raw)).toEqual(['a', 'b']);
  });

  it('still reports a compiling pattern with no group as having no group', () => {
    const diags: ValidationDiagnostic[] = [];
    breakLines('a\nb\n', [dir('LINE_BREAKER', '-----')], META, runCtx(diags));
    const lb = diags.filter((d) => d.directiveKey === 'LINE_BREAKER');
    expect(lb).toHaveLength(1);
    expect(lb[0]!.message).toContain('no capturing group');
    expect(lb[0]!.message).not.toContain('does not compile');
  });
});

describe('#161 — MUST_BREAK_AFTER does not license merging', () => {
  it('breaks every line when it is the only rule in force', () => {
    const raw = '2026-01-15T10:00:00Z alpha\nmiddle\nEND\n2026-01-15T10:00:01Z beta\nmiddle\nEND\n';
    const events = breakLines(
      raw,
      [dir('SHOULD_LINEMERGE', 'true'), dir('BREAK_ONLY_BEFORE_DATE', 'false'), dir('MUST_BREAK_AFTER', 'END')],
      META,
      runCtx(),
    );
    expect(events).toHaveLength(6);
  });

  it('still merges when a continue rule is present alongside it', () => {
    const raw = 'START one\ncont\nEND\nSTART two\ncont\n';
    const events = breakLines(
      raw,
      [dir('BREAK_ONLY_BEFORE', '^START'), dir('BREAK_ONLY_BEFORE_DATE', 'false'), dir('MUST_BREAK_AFTER', 'END')],
      META,
      runCtx(),
    );
    expect(events).toHaveLength(2);
  });
});

describe('breakLines — MUST_NOT_BREAK_BEFORE / MUST_NOT_BREAK_AFTER (#190)', () => {
  it('MUST_NOT_BREAK_BEFORE is inert: a BREAK_ONLY_BEFORE break still stands', () => {
    // Pinned by the capture `linebreak-must-not-break-before-explicit`: the
    // spec sentence describes a suppression measured Splunk does not perform.
    const events = breakLines(
      'EVENT one\ndetail\nEVENT protected\nEVENT two',
      [
        dir('SHOULD_LINEMERGE', 'true'),
        dir('BREAK_ONLY_BEFORE', '^EVENT'),
        dir('MUST_NOT_BREAK_BEFORE', '^EVENT protected'),
      ],
      META,
      runCtx(),
    );
    expect(events.map((e) => e._raw)).toEqual([
      'EVENT one\ndetail',
      'EVENT protected',
      'EVENT two',
    ]);
  });

  it('MUST_NOT_BREAK_BEFORE is inert against a BREAK_ONLY_BEFORE_DATE break too', () => {
    // Mirrors the fixture `linebreak-must-not-break-before`.
    const events = breakLines(
      '2026-01-15T10:00:00Z first\n2026-01-15T10:00:01Z suppressed break\n2026-01-15T10:00:02Z second',
      [
        dir('SHOULD_LINEMERGE', 'true'),
        dir('BREAK_ONLY_BEFORE_DATE', 'true'),
        dir('MUST_NOT_BREAK_BEFORE', '^2026-01-15T10:00:01Z'),
      ],
      META,
      runCtx(),
    );
    expect(events).toHaveLength(3);
  });

  it('does not defeat the MAX_EVENTS cap', () => {
    const raw = Array.from({ length: 6 }, (_, i) => `line${i}`).join('\n');
    const events = breakLines(
      raw,
      [
        dir('SHOULD_LINEMERGE', 'true'),
        dir('MAX_EVENTS', '2'),
        dir('MUST_NOT_BREAK_BEFORE', '.*'),
      ],
      META,
      runCtx(),
    );
    expect(events).toHaveLength(2);
    expect(events[0]!._raw.split('\n')).toHaveLength(3);
  });

  it('MUST_NOT_BREAK_AFTER suppresses date breaks until MUST_BREAK_AFTER matches', () => {
    const events = breakLines(
      '2026-01-15T10:00:00Z BEGIN\n' +
        '2026-01-15T10:00:01Z inside\n' +
        '2026-01-15T10:00:02Z END\n' +
        '2026-01-15T10:00:03Z after',
      [
        dir('SHOULD_LINEMERGE', 'true'),
        dir('BREAK_ONLY_BEFORE_DATE', 'true'),
        dir('MUST_NOT_BREAK_AFTER', 'BEGIN'),
        dir('MUST_BREAK_AFTER', 'END'),
      ],
      META,
      runCtx(),
    );
    expect(events.map((e) => e._raw)).toEqual([
      '2026-01-15T10:00:00Z BEGIN\n2026-01-15T10:00:01Z inside\n2026-01-15T10:00:02Z END',
      '2026-01-15T10:00:03Z after',
    ]);
  });

  it('MUST_NOT_BREAK_AFTER with no MUST_BREAK_AFTER suppresses to the end of input', () => {
    const events = breakLines(
      '2026-01-15T10:00:00Z BEGIN\n2026-01-15T10:00:01Z a\n2026-01-15T10:00:02Z b',
      [
        dir('SHOULD_LINEMERGE', 'true'),
        dir('BREAK_ONLY_BEFORE_DATE', 'true'),
        dir('MUST_NOT_BREAK_AFTER', 'BEGIN'),
      ],
      META,
      runCtx(),
    );
    expect(events).toHaveLength(1);
  });

  it('warns when a MUST_NOT_BREAK_AFTER pattern cannot be compiled', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    breakLines(
      'a\nb',
      [dir('SHOULD_LINEMERGE', 'true'), dir('MUST_NOT_BREAK_AFTER', '(')],
      META,
      runCtx(diagnostics),
    );
    expect(diagnostics.some((d) => d.message.includes('MUST_NOT_BREAK_AFTER'))).toBe(true);
  });
});

describe('breakLines — LINE_BREAKER capture groups counted on the translated pattern (#311)', () => {
  // Doc-derived: props.conf.spec reads LINE_BREAKER as a PCRE whose first
  // capturing group is the break. `(?i)` is PCRE's inline case-insensitive
  // flag, which JS only accepts once translated, so the group must be counted
  // on the same translation the split compiles.
  it('accepts a leading (?i) and breaks on its group instead of falling back to the default', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const events = breakLines(
      'DATE one\nDate two\ndate three',
      [dir('LINE_BREAKER', '(?i)([\\r\\n]+)date'), dir('SHOULD_LINEMERGE', 'false')],
      META,
      runCtx(diagnostics),
    );
    expect(diagnostics.filter((d) => d.directiveKey === 'LINE_BREAKER')).toEqual([]);
    // The pattern's own `date` is outside the group, so it stays on the next event.
    expect(events.map((e) => e._raw)).toEqual(['DATE one', 'Date two', 'date three']);
  });

  it('still warns when the translated pattern genuinely has no capturing group', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    breakLines('a\nb', [dir('LINE_BREAKER', '(?i)[\\r\\n]+'), dir('SHOULD_LINEMERGE', 'false')], META, runCtx(diagnostics));
    expect(diagnostics.some((d) => d.message.includes('has no capturing group'))).toBe(true);
  });
});

describe('breakLines — lineNumbers.end measured on the original input (#317)', () => {
  // Doc-derived: the default LINE_BREAKER `([\r\n]+)` discards the whole run of
  // line endings it matches, so a merged event's `_raw` is shorter than the
  // stretch of input it came from. The reported line range describes the input.
  it('spans the blank lines a merge swallowed', () => {
    const raw = '2026-01-15 10:00:00 x\n\n\n\n\n\nc\n2026-01-15 10:00:01 y';
    const events = breakLines(raw, [], META, runCtx());
    expect(events.map((e) => e._raw)).toEqual(['2026-01-15 10:00:00 x\nc', '2026-01-15 10:00:01 y']);
    expect(events.map((e) => e.lineNumbers)).toEqual([
      { start: 1, end: 7 },
      { start: 8, end: 8 },
    ]);
  });

  it('counts every line of a CRLF event, not one fewer per merged line', () => {
    const raw = '2026-01-15 10:00:00 a\r\nb\r\nc\r\nd\r\ne\r\n2026-01-15 10:00:01 f\r\n';
    const events = breakLines(raw, [], META, runCtx());
    expect(events).toHaveLength(2);
    expect(events[0]!.lineNumbers).toEqual({ start: 1, end: 5 });
    expect(events[1]!.lineNumbers).toEqual({ start: 6, end: 6 });
  });

  // Doc-derived: LINE_BREAKER discards only its first capture group, so a
  // breaker that captures `---` leaves the preceding `\n` in the event. That
  // newline ends the event's last line; it does not start another.
  const dashes = [dir('LINE_BREAKER', '(---)'), dir('SHOULD_LINEMERGE', 'false')];

  it('ends a segment that keeps its trailing \\n on that line, not the next (#331)', () => {
    const events = breakLines('a\n---b\n---c', dashes, META, runCtx());
    expect(events.map((e) => e._raw)).toEqual(['a\n', 'b\n', 'c']);
    expect(events.map((e) => e.lineNumbers)).toEqual([
      { start: 1, end: 1 },
      { start: 2, end: 2 },
      { start: 3, end: 3 },
    ]);
  });

  it('ends a CRLF-terminated segment on its own line (#331)', () => {
    const events = breakLines('a\r\n---b\r\n---c', dashes, META, runCtx());
    expect(events.map((e) => e.lineNumbers)).toEqual([
      { start: 1, end: 1 },
      { start: 2, end: 2 },
      { start: 3, end: 3 },
    ]);
  });

  it('still spans every line of a multi-line segment ending in \\n (#331)', () => {
    const events = breakLines('a\nb\n---c', dashes, META, runCtx());
    expect(events[0]!.lineNumbers).toEqual({ start: 1, end: 2 });
    expect(events[1]!.lineNumbers).toEqual({ start: 3, end: 3 });
  });
});

describe('breakLines — the SHOULD_LINEMERGE default INDEXED_EXTRACTIONS implies (#322)', () => {
  // Doc-derived: structured INDEXED_EXTRACTIONS formats are one record per
  // line, while the XML modes keep ordinary line merging. breakLines is
  // the only place this default is decided, so it must hold with no pipeline
  // injecting a SHOULD_LINEMERGE for it.
  const raw = 'a,1\nb,2\nc,3';

  it.each(['csv', 'TSV', 'psv', 'w3c', 'json'])('does not merge lines for INDEXED_EXTRACTIONS = %s', (format) => {
    expect(breakLines(raw, [dir('INDEXED_EXTRACTIONS', format)], META, runCtx())).toHaveLength(3);
  });

  it('keeps merging for the XML modes', () => {
    expect(breakLines(raw, [dir('INDEXED_EXTRACTIONS', 'xml')], META, runCtx())).toHaveLength(1);
  });

  it('lets an explicit SHOULD_LINEMERGE win over the format default', () => {
    expect(breakLines(raw, [dir('INDEXED_EXTRACTIONS', 'csv'), dir('SHOULD_LINEMERGE', 'true')], META, runCtx())).toHaveLength(1);
  });
});

describe('breakLines — BREAK_ONLY_BEFORE_DATE honours the stanza timestamp settings (#352)', () => {
  // Doc-derived: props.conf.spec says BREAK_ONLY_BEFORE_DATE starts an event
  // "only if it encounters a new line with a date", and that the setting is not
  // meaningful when DATETIME_CONFIG stops timestamps being identified — so the
  // date is the one the stanza's timestamp settings recognise. No capture
  // covers a custom TIME_FORMAT with line merging.
  it('breaks before each line TIME_FORMAT recognises, and merges the rest', () => {
    const raw = '15.01.2026 10:00:01 a\n15.01.2026 10:00:02 b\n  continuation\n15.01.2026 10:00:03 c';
    const events = breakLines(raw, [dir('TIME_FORMAT', '%d.%m.%Y %H:%M:%S')], META, runCtx());
    expect(events.map((e) => e._raw)).toEqual([
      '15.01.2026 10:00:01 a',
      '15.01.2026 10:00:02 b\n  continuation',
      '15.01.2026 10:00:03 c',
    ]);
  });

  it('recognises a compact numeric TIME_FORMAT the built-in patterns do not', () => {
    const raw = '20260115100000 a\n20260115100001 a\n20260115100002 a';
    expect(breakLines(raw, [dir('TIME_FORMAT', '%Y%m%d%H%M%S')], META, runCtx())).toHaveLength(3);
  });

  it('reads the format only after TIME_PREFIX', () => {
    const raw = 'ts=10:00:00 a\nts=10:00:01 b\nnote 10:00:02 no prefix\nts=10:00:03 c';
    const events = breakLines(raw, [dir('TIME_PREFIX', 'ts='), dir('TIME_FORMAT', '%H:%M:%S')], META, runCtx());
    expect(events.map((e) => e._raw)).toEqual([
      'ts=10:00:00 a',
      'ts=10:00:01 b\nnote 10:00:02 no prefix',
      'ts=10:00:03 c',
    ]);
  });

  it('looks for the format only within MAX_TIMESTAMP_LOOKAHEAD', () => {
    const raw = 'first 15.01.2026 10:00:01\nlater 15.01.2026 10:00:02';
    const directives = [dir('TIME_FORMAT', '%d.%m.%Y %H:%M:%S')];
    expect(breakLines(raw, directives, META, runCtx())).toHaveLength(2);
    expect(breakLines(raw, [...directives, dir('MAX_TIMESTAMP_LOOKAHEAD', '10')], META, runCtx())).toHaveLength(1);
  });

  it('does not break on a match TIME_FORMAT cannot parse', () => {
    // 45.01.2026 has the format's shape but is not a date.
    const raw = '15.01.2026 10:00:01 a\n45.01.2026 10:00:02 b';
    expect(breakLines(raw, [dir('TIME_FORMAT', '%d.%m.%Y %H:%M:%S')], META, runCtx())).toHaveLength(1);
  });

  it('with TIME_PREFIX alone, looks for the built-in date forms after the prefix', () => {
    const raw = 'at=2026-01-15 10:00:00 a\nx 2026-01-15 10:00:01 no prefix\nat=2026-01-15 10:00:02 b';
    expect(breakLines(raw, [dir('TIME_PREFIX', 'at=')], META, runCtx())).toHaveLength(2);
  });
});
