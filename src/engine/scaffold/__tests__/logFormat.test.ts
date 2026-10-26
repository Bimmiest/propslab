// ---------------------------------------------------------------------------
// logFormat.test.ts
// The format named on the Raw Log chip (#742): the formats a line shows by
// itself, then the Scaffold's structural ones, and which wins when a sample
// shows both.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { detectLogFormat } from '../analyzers/logFormat';

const lines = (...l: string[]) => l.join('\n');
const nameOf = (raw: string) => detectLogFormat(raw)?.name ?? null;

describe('detectLogFormat', () => {
  it.each([
    [
      'CEF',
      lines(
        'CEF:0|Vendor|Product|1.0|100|Login|5|src=10.0.0.1 suser=bob',
        'CEF:0|Vendor|Product|1.0|101|Logout|3|src=10.0.0.2 suser=amy',
      ),
    ],
    [
      'LEEF',
      lines(
        'LEEF:2.0|Vendor|Product|1.0|4625|src=10.0.0.1\tusrName=bob',
        'LEEF:1.0|Vendor|Product|1.0|4624|src=10.0.0.2',
      ),
    ],
    [
      'Syslog (RFC 5424)',
      lines(
        '<34>1 2026-10-11T22:14:15.003Z host01 su - ID47 - su root failed on /dev/pts/8',
        '<165>1 2026-10-11T22:14:16.000Z host02 app 1234 - - started',
      ),
    ],
    [
      'Syslog',
      lines(
        'Oct 26 13:55:36 web01 sshd[1234]: Accepted password for bob',
        '<13>Oct  6 13:55:37 web02 cron[99]: job done',
        // Cisco ASA puts the year after the day.
        'Oct 25 2026 08:30:01 asa-edge-01 : %ASA-6-302013: Built inbound TCP connection',
      ),
    ],
    [
      'Access log',
      lines(
        '198.51.100.10 - frank [25/Oct/2026:13:55:36 -0700] "GET /a.gif HTTP/1.0" 200 2326',
        '198.51.100.20 - - [25/Oct/2026:13:55:37 -0700] "POST /login HTTP/1.1" 403 512',
      ),
    ],
    ['W3C', lines('#Software: Microsoft IIS', '#Fields: date time cs-method', '2026-10-26 13:55:36 GET')],
    ['JSON', lines('{"a":1,"msg":"x"}', '{"a":2,"msg":"y"}')],
    ['JSON', lines('{', '  "a": 1,', '  "b": [1, 2]', '}')],
    ['XML', lines('<Event><System><EventID>4624</EventID></System></Event>')],
    [
      'Key=value',
      lines('date=2026-10-26 time=13:55:36 devname="FG-1" action=accept', 'date=2026-10-26 time=13:55:37 x=1 y=2'),
    ],
    ['CSV', lines('time,user,action', '2026-10-26,bob,login', '2026-10-26,amy,logout')],
    ['TSV', lines('time\tuser\taction', '1\tbob\tlogin', '2\tamy\tlogout')],
    [
      'Multi-line',
      lines(
        '2026-10-26 13:55:36 ERROR boom',
        '    at com.example.A.run(A.java:10)',
        '    at com.example.B.run(B.java:20)',
      ),
    ],
  ])('names %s', (name, raw) => {
    expect(nameOf(raw)).toBe(name);
  });

  it('names nothing in an empty sample or plain text', () => {
    expect(detectLogFormat('')).toBeNull();
    expect(detectLogFormat('   \n\n')).toBeNull();
    expect(nameOf(lines('hello there', 'nothing to see'))).toBeNull();
  });

  it('gives the evidence for the tooltip', () => {
    expect(detectLogFormat(lines('{"a":1}', '{"a":2}'))?.evidence).toBe('2/2 lines parse as JSON');
    expect(detectLogFormat(lines('{', '  "a": 1', '}', '{', '  "a": 2', '}'))?.evidence).toBe(
      'Multiple newline-separated JSON objects',
    );
    expect(
      detectLogFormat(
        lines(
          'CEF:0|V|P|1|1|n|5|a=1',
          'CEF:0|V|P|1|1|n|5|a=2',
          'plain line',
          'CEF:0|V|P|1|1|n|5|a=3',
          'CEF:0|V|P|1|1|n|5|a=4',
        ),
      )?.evidence,
    ).toBe('4/5 lines start with a CEF header');
  });

  it('names CEF behind a syslog header, not syslog, and not PSV for its pipes', () => {
    expect(
      nameOf(
        lines(
          '<134>Oct 26 13:55:36 fw01 CEF:0|Vendor|Product|1.0|100|Login|5|src=10.0.0.1',
          '<134>Oct 26 13:55:37 fw01 CEF:0|Vendor|Product|1.0|101|Logout|3|src=10.0.0.2',
        ),
      ),
    ).toBe('CEF');
  });

  it('names JSON whose message holds key=value pairs JSON, and key=value lines with commas Key=value', () => {
    expect(nameOf(lines('{"msg":"user=bob src=1 dst=2"}', '{"msg":"user=amy src=3 dst=4"}'))).toBe('JSON');
    expect(nameOf(lines('a=1, b=2, c=3', 'a=4, b=5, c=6'))).toBe('Key=value');
  });

  it('does not count indented continuation lines against a header format', () => {
    expect(
      nameOf(
        lines(
          'Oct 26 13:55:36 app01 java[1]: Exception in thread "main"',
          '    at com.example.A.run(A.java:10)',
          '    at com.example.B.run(B.java:20)',
          'Oct 26 13:55:37 app01 java[1]: recovered',
        ),
      ),
    ).toBe('Syslog');
  });

  it('needs most lines to share a header format', () => {
    expect(nameOf(lines('Oct 26 13:55:36 web01 sshd: one', 'free text', 'more free text'))).toBeNull();
  });

  it('reads only the first lines of a large paste', () => {
    const csv = ['a,b,c', ...Array.from({ length: 300 }, (_, i) => `${i},x,y`)];
    // Line 250 onwards would break the column count; the sample never reaches them.
    const raw = [...csv.slice(0, 250), ...Array.from({ length: 100 }, () => 'no commas here')].join('\n');
    expect(nameOf(raw)).toBe('CSV');
  });
});
