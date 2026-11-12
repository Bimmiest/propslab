import { describe, it, expect } from 'vitest';
import { MISSPELLED_MESSAGE } from 'propslab-engine';
import { computeDiagnostics, MISSPELLED_MARKER_CODE } from '../splunkConfDiagnostics';
import { fakeModel } from '../../test/fakeModel';
import { expectLinearWork } from '../../test/scanWork';

describe('computeDiagnostics — continuation gating (#24)', () => {
  it('validates the line after a backslash-terminated stanza header', () => {
    const text = '[my_stanza] \\\nREGEX = (unbalanced';
    const markers = computeDiagnostics(fakeModel(text), 'transforms.conf');
    // The invalid regex on line 2 must be reported — a stanza header cannot have
    // a continuation, so line 2 must not be swallowed as one.
    expect(markers.some((m) => m.startLineNumber === 2 && /Invalid regex/.test(m.message))).toBe(true);
  });

  it('validates a directive after a backslash-terminated malformed line', () => {
    const text = 'garbage line \\\nREGEX = (unbalanced';
    const markers = computeDiagnostics(fakeModel(text), 'transforms.conf');
    expect(markers.some((m) => m.startLineNumber === 2 && /Invalid regex/.test(m.message))).toBe(true);
  });

  it('still treats a real directive continuation as value, not a malformed line', () => {
    const text = 'TIME_FORMAT = %Y \\\n%m %d';
    const markers = computeDiagnostics(fakeModel(text), 'props.conf');
    // Line 2 is part of TIME_FORMAT's value — it must not be flagged.
    expect(markers.some((m) => m.startLineNumber === 2)).toBe(false);
  });

  it('reads the directive after a continued # line as a directive, as confParser does (#354)', () => {
    const text = '[s]\nREGEX = foo\\\n# note\nkv_mode = json';
    const markers = computeDiagnostics(fakeModel(text), 'props.conf');
    // Line 3 is REGEX's value; line 4 is its own (mis-cased) directive.
    expect(markers.some((m) => m.startLineNumber === 3)).toBe(false);
    expect(markers.some((m) => m.startLineNumber === 4 && /case-sensitive/.test(m.message))).toBe(true);
  });
});

describe('computeDiagnostics — continued values are validated as a whole (#70.1)', () => {
  it('does not report a regex error on a valid backslash-continued LINE_BREAKER', () => {
    const text = '[st]\nLINE_BREAKER = ([\\r\\n]+)(?=\\d{4}-\\\n\\d{2})';
    const markers = computeDiagnostics(fakeModel(text), 'props.conf');
    expect(markers.filter((m) => /Invalid regex/.test(m.message))).toHaveLength(0);
  });

  it('still reports a regex error that survives the join', () => {
    const text = '[st]\nLINE_BREAKER = ([\\r\\n]+)(?=\\d{4}-\\\n\\d{2}';
    const markers = computeDiagnostics(fakeModel(text), 'props.conf');
    expect(markers.some((m) => /Invalid regex/.test(m.message))).toBe(true);
  });

  it('joins a long run of continuation lines in linear time (#468)', () => {
    // Re-concatenating the whole value per line made this quadratic. Every
    // continuation line belongs to the one value, so none is read as a
    // directive or reported as malformed.
    // Counted, not timed (#507): the length copied and scanned by slices, joins
    // and searches must not much more than double when the number of lines does.
    const conf = (lines: number) => `[st]\nTIME_FORMAT = %Y\\\n${'a\\\n'.repeat(lines)}`;
    expectLinearWork((lines) => {
      const model = fakeModel(conf(lines));
      return () => void computeDiagnostics(model, 'props.conf');
    }, 5_000);
    const markers = computeDiagnostics(fakeModel(conf(200_000)), 'props.conf');
    expect(markers).toEqual([]);
  });

  it('treats an even backslash run as a literal, not a continuation', () => {
    // `C:\\` is a Windows path ending in one escaped backslash, not a continuation.
    const text = '[st]\nEXTRACT-p = path=(?<path>C:\\\\)\n';
    const markers = computeDiagnostics(fakeModel(text), 'props.conf');
    expect(markers.filter((m) => /Invalid regex/.test(m.message))).toHaveLength(0);
  });
});

describe('computeDiagnostics — named groups count as capturing (#70.2)', () => {
  it('does not warn for a named LINE_BREAKER group', () => {
    const markers = computeDiagnostics(fakeModel('[st]\nLINE_BREAKER = (?<br>[\\r\\n]+)'), 'props.conf');
    expect(markers.some((m) => /at least one capturing group/.test(m.message))).toBe(false);
  });

  it('does not warn for a Python-style named group', () => {
    const markers = computeDiagnostics(fakeModel('[st]\nLINE_BREAKER = (?P<br>[\\r\\n]+)'), 'props.conf');
    expect(markers.some((m) => /at least one capturing group/.test(m.message))).toBe(false);
  });

  it('still warns when the only group is a lookbehind', () => {
    const markers = computeDiagnostics(fakeModel('[st]\nLINE_BREAKER = (?<=x)[\\r\\n]+'), 'props.conf');
    expect(markers.some((m) => /at least one capturing group/.test(m.message))).toBe(true);
  });

  it('still warns when the only group is non-capturing', () => {
    const markers = computeDiagnostics(fakeModel('[st]\nLINE_BREAKER = (?:[\\r\\n]+)'), 'props.conf');
    expect(markers.some((m) => /at least one capturing group/.test(m.message))).toBe(true);
  });
});

describe('computeDiagnostics — SHOULD_LINEMERGE best practice inspects the value (#31.2)', () => {
  const withBreaker = (linemerge: string) =>
    computeDiagnostics(fakeModel(`[st]\nLINE_BREAKER = ([\\r\\n]+)\n${linemerge}`), 'props.conf');

  const warned = (markers: { message: string }[]) => markers.some((m) => /SHOULD_LINEMERGE = false/.test(m.message));

  it('warns when SHOULD_LINEMERGE is set to true', () => {
    expect(warned(withBreaker('SHOULD_LINEMERGE = true'))).toBe(true);
  });

  it('stays quiet when it is set to false', () => {
    expect(warned(withBreaker('SHOULD_LINEMERGE = false'))).toBe(false);
  });

  it('accepts 0 and no as false', () => {
    expect(warned(withBreaker('SHOULD_LINEMERGE = 0'))).toBe(false);
    expect(warned(withBreaker('SHOULD_LINEMERGE = no'))).toBe(false);
  });

  it('still warns when it is absent entirely', () => {
    expect(warned(computeDiagnostics(fakeModel('[st]\nLINE_BREAKER = ([\\r\\n]+)'), 'props.conf'))).toBe(true);
  });
});

describe('computeDiagnostics — undocumented attributes are not typos (#178)', () => {
  const typoMarkers = (text: string, file: 'props.conf' | 'transforms.conf' = 'props.conf') =>
    computeDiagnostics(fakeModel(text), file).filter((m) => /possible typo/.test(m.message));

  it('does not call a valid Splunk attribute a possible typo', () => {
    // The engine warns that the preview ignores it; calling it a typo as well
    // sends the user to check spelling that is already correct.
    //
    // Each key is checked against the conf file it belongs to, so a
    // transforms.conf key is not excused in props.conf.
    expect(typoMarkers('[st]\nKV_TRIM_SPACES = true')).toEqual([]);
    expect(typoMarkers('[st]\nSTOP_PROCESSING_IF = foo', 'transforms.conf')).toEqual([]);
  });

  it('still flags an actual misspelling', () => {
    expect(typoMarkers('[st]\nSTOP_PROCESING_IF = foo')).toHaveLength(1);
  });

  it('still flags a key that resembles nothing at all', () => {
    expect(typoMarkers('[st]\nNOT_A_REAL_DIRECTIVE = 1')).toHaveLength(1);
  });
});

describe('computeDiagnostics — a key one edit from an attribute (#899)', () => {
  it('warns on the key with the sentence the engine uses, tagged for the quick fix', () => {
    expect(computeDiagnostics(fakeModel('[st]\nTIME_FROMAT = %Y'), 'props.conf')).toEqual([
      {
        severity: 4,
        message: MISSPELLED_MESSAGE('TIME_FROMAT', 'TIME_FORMAT', 'props.conf'),
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 'TIME_FROMAT '.length + 1,
        code: MISSPELLED_MARKER_CODE,
      },
    ]);
  });
});

describe('computeDiagnostics — unsimulated strftime specifiers (#90)', () => {
  const specifierMarkers = (text: string) =>
    computeDiagnostics(fakeModel(text), 'props.conf').filter((m) => /not simulated/.test(m.message));

  it('says nothing about a format built from supported specifiers', () => {
    expect(specifierMarkers('[st]\nTIME_FORMAT = %Y-%m-%dT%H:%M:%S')).toEqual([]);
  });

  it('flags a specifier the preview will treat as literal text', () => {
    const markers = specifierMarkers('[st]\nTIME_FORMAT = %Y-%m-%d %H:%i');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.severity).toBe(2); // Info — a real indexer may parse it.
  });

  it('underlines the specifier itself, not the whole line', () => {
    const marker = specifierMarkers('[st]\nTIME_FORMAT = %Y-%m-%d %H:%i')[0]!;
    const line = '[st]\nTIME_FORMAT = %Y-%m-%d %H:%i'.split('\n')[1]!;
    expect(line.slice(marker.startColumn - 1, marker.endColumn - 1)).toBe('%i');
  });
});

describe('computeDiagnostics — regexes are checked by PCRE2 itself (#368)', () => {
  it('accepts PCRE syntax a JS regex lacks, with no approximation warning', () => {
    for (const pattern of ['a (?x) b', '\\Aab\\z', 'x++(?>y)', '(?<=\\})\\K\\w+', '\\((?:[^()]|(?R))*\\)']) {
      const markers = computeDiagnostics(fakeModel(`[st]\nREGEX = ${pattern}`), 'transforms.conf');
      expect(
        markers.filter((m) => m.startLineNumber === 2),
        pattern,
      ).toEqual([]);
    }
  });

  it('reports what PCRE2 rejects, in its words', () => {
    const markers = computeDiagnostics(fakeModel('[st]\nREGEX = (?<=a+)b'), 'transforms.conf');
    expect(markers.find((m) => /Invalid regex/.test(m.message))?.message).toMatch(/lookbehind/);
  });
});

describe('computeDiagnostics — booleans read as the engine reads them (#301)', () => {
  const booleanMarkers = (text: string) =>
    computeDiagnostics(fakeModel(text), 'props.conf').filter((m) => m.message.startsWith('Expected boolean'));

  it('accepts every spelling the engine honours', () => {
    for (const v of ['t', 'F', 'y', 'n', 'on', 'OFF', 'yes', '0']) {
      expect(booleanMarkers(`[st]\nSHOULD_LINEMERGE = ${v}\n`)).toEqual([]);
    }
  });

  it('still flags a value that is not a boolean', () => {
    expect(booleanMarkers('[st]\nSHOULD_LINEMERGE = maybe\n')).toHaveLength(1);
  });

  it('treats SHOULD_LINEMERGE = off as disabling merge beside a custom LINE_BREAKER', () => {
    const markers = computeDiagnostics(
      fakeModel('[st]\nLINE_BREAKER = ([\\r\\n]+)\nSHOULD_LINEMERGE = off\n'),
      'props.conf',
    );
    expect(markers.some((m) => m.message.includes('Set SHOULD_LINEMERGE = false'))).toBe(false);
  });
});

describe('computeDiagnostics — stanza headers and malformed lines', () => {
  /** The markers of line `lineNumber`, as message, severity and columns. */
  function markersOn(text: string, lineNumber: number) {
    return computeDiagnostics(fakeModel(text), 'props.conf')
      .filter((m) => m.startLineNumber === lineNumber)
      .map((m) => [m.message, m.severity, m.startColumn, m.endColumn]);
  }

  it('calls "[]" an empty header, and an unclosed one a missing bracket, over the whole line', () => {
    expect(markersOn('[]', 1)).toEqual([['Empty stanza header — expected "[name]"', 8, 1, 3]]);
    expect(markersOn('[abc', 1)).toEqual([['Missing closing bracket "]" for stanza header', 8, 1, 5]]);
  });

  it('warns on a repeated stanza, by its trimmed name, over the whole header', () => {
    expect(markersOn('[a]\nX = 1\n[ a ]', 3)).toEqual([
      [
        'Duplicate stanza "a" — Splunk merges duplicate stanzas key-by-key (a later key overrides the same earlier key; keys only in the earlier stanza are kept)',
        4,
        1,
        6,
      ],
    ]);
    expect(markersOn('[a]\nX = 1\n[b]', 3)).toEqual([]);
  });

  it('says why a line is malformed, and an indented one differently', () => {
    expect(markersOn('[a]\ngarbage', 2)).toEqual([
      [
        'Malformed line — expected "key = value" or a stanza header. Splunk .conf lines are "key = value", "[stanza]", or a "#" comment.',
        8,
        1,
        8,
      ],
    ]);
    const [indented] = markersOn('[a]\n  garbage', 2);
    expect(indented?.[0]).toMatch(/cannot be indented; Splunk continues a value with a trailing backslash/);
    expect(indented?.slice(1)).toEqual([8, 1, 10]);
  });
});
