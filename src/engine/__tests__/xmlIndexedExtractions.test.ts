// ---------------------------------------------------------------------------
// INDEXED_EXTRACTIONS = xml / xmlkv / xmlkv-winevt and the XML_IE_* filters
// (#271).
//
// Doc-derived throughout. No capture covers index-time XML, so what each
// attribute does is read from props.conf.spec 10.4.3 and asserted narrowly.
// Field *naming* is not in the spec at all: `xml` borrows KV_MODE = xml's
// convention, `xmlkv` the xmlkv search command's, and `xmlkv-winevt` the
// Windows event-log Name convention (see xmlIndexedExtractions.ts). If real
// Splunk names them differently, the naming tests are the ones to correct.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { applyIndexedExtractions } from '../processors/indexedExtractions';
import { runPipeline } from '../pipeline';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';

function event(raw: string): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

function d(key: string, value: string): ConfDirective {
  return { key, value, line: 1, directiveType: key };
}

/** INDEXED_EXTRACTIONS = <mode> with the pipeline switch the spec requires. */
function xmlDirs(mode: string, ...rest: ConfDirective[]): ConfDirective[] {
  return [d('INDEXED_EXTRACTIONS', mode), d('XML_INDEXED_EXTRACTIONS_PIPELINE', 'typing'), ...rest];
}

function fieldsOf(raw: string, directives: ConfDirective[]) {
  return applyIndexedExtractions([event(raw)], directives)[0]!.fields;
}

const WINEVT =
  "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>" +
  "<System><Provider Name='Microsoft-Windows-Security-Auditing'/><EventID>4624</EventID>" +
  "<Computer>dc01</Computer></System>" +
  "<EventData><Data Name='SubjectUserName'>alice</Data><Data Name='LogonType'>3</Data></EventData>" +
  '</Event>';

describe('INDEXED_EXTRACTIONS xml family — naming (#271)', () => {
  it('xml names leaves by dotted path from the root, as KV_MODE = xml does', () => {
    const f = fieldsOf('<event><user>alice</user><src ip="10.0.0.1"/></event>', xmlDirs('xml'));
    expect(f['event.user']).toBe('alice');
    expect(f['ip']).toBe('10.0.0.1');
  });

  it('xmlkv names leaves by their own tag, as the xmlkv command does', () => {
    const f = fieldsOf('<event><user>alice</user><action>login</action></event>', xmlDirs('xmlkv'));
    expect(f).toMatchObject({ user: 'alice', action: 'login' });
    expect(f['event.user']).toBeUndefined();
  });

  it('xmlkv-winevt names Data leaves by their Name attribute', () => {
    const f = fieldsOf(WINEVT, xmlDirs('xmlkv-winevt'));
    expect(f).toMatchObject({
      SubjectUserName: 'alice',
      LogonType: '3',
      EventID: '4624',
      Computer: 'dc01',
      Provider_Name: 'Microsoft-Windows-Security-Auditing',
    });
    // The Name attribute became the field name; it is not also Data_Name.
    expect(f['Data_Name']).toBeUndefined();
  });

  it('matches the mode case-insensitively', () => {
    expect(fieldsOf('<a><b>1</b></a>', xmlDirs('XMLKV'))['b']).toBe('1');
  });

  it('extracts nothing from an event that is not XML', () => {
    expect(fieldsOf('not <xml', xmlDirs('xml'))).toEqual({});
  });

  it('collects repeated leaves into a multivalue field', () => {
    expect(fieldsOf('<r><ip>1</ip><ip>2</ip></r>', xmlDirs('xmlkv'))['ip']).toEqual(['1', '2']);
  });
});

describe('XML_INDEXED_EXTRACTIONS_PIPELINE (#271)', () => {
  it('is required: without it the XML values extract nothing, and say why', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const out = applyIndexedExtractions(
      [event('<a><b>1</b></a>')],
      [d('INDEXED_EXTRACTIONS', 'xml')],
      diagnostics,
    );
    expect(out[0]!.fields).toEqual({});
    expect(diagnostics.some((x) => x.directiveKey === 'XML_INDEXED_EXTRACTIONS_PIPELINE')).toBe(true);
  });

  it('rejects a value outside the four pipelines', () => {
    const f = fieldsOf('<a><b>1</b></a>', [
      d('INDEXED_EXTRACTIONS', 'xml'),
      d('XML_INDEXED_EXTRACTIONS_PIPELINE', 'parsing'),
    ]);
    expect(f).toEqual({});
  });

  it('accepts each of the four pipelines alike', () => {
    for (const p of ['structuredparsing', 'wineventlog', 'typing', 'exec']) {
      const f = fieldsOf('<a><b>1</b></a>', [
        d('INDEXED_EXTRACTIONS', 'xmlkv'),
        d('XML_INDEXED_EXTRACTIONS_PIPELINE', p),
      ]);
      expect(f['b'], p).toBe('1');
    }
  });
});

describe('XML_IE_INCLUDE / XML_IE_EXCLUDE (#271)', () => {
  const raw = '<e><ProcessName>a.exe</ProcessName><ParentProcessName>b.exe</ParentProcessName><EventID>1</EventID><User>x</User></e>';

  it('keeps only the fields INCLUDE names, with * wildcards', () => {
    const f = fieldsOf(raw, xmlDirs('xmlkv', d('XML_IE_INCLUDE', '*Process*,Event*')));
    expect(Object.keys(f).sort()).toEqual(['EventID', 'ParentProcessName', 'ProcessName']);
  });

  it('removes what EXCLUDE names from what INCLUDE let through', () => {
    const f = fieldsOf(
      raw,
      xmlDirs('xmlkv', d('XML_IE_INCLUDE', '*Process*,Event*'), d('XML_IE_EXCLUDE', 'Parent*')),
    );
    expect(Object.keys(f).sort()).toEqual(['EventID', 'ProcessName']);
  });

  it('matches the whole field name, not a substring', () => {
    const f = fieldsOf(raw, xmlDirs('xmlkv', d('XML_IE_INCLUDE', 'Process')));
    expect(f).toEqual({});
  });
});

describe('XML_IE_INCLUDE_MV / XML_IE_EXCLUDE_MV (#271)', () => {
  const raw = '<r><ip>1</ip><ip>2</ip><port>80</port><port>443</port></r>';

  it('lets a field outside INCLUDE_MV keep only its first value', () => {
    const f = fieldsOf(raw, xmlDirs('xmlkv', d('XML_IE_INCLUDE_MV', 'ip')));
    expect(f['ip']).toEqual(['1', '2']);
    expect(f['port']).toBe('80');
  });

  it('keeps only the first value of a field EXCLUDE_MV names', () => {
    const f = fieldsOf(raw, xmlDirs('xmlkv', d('XML_IE_EXCLUDE_MV', 'port')));
    expect(f['ip']).toEqual(['1', '2']);
    expect(f['port']).toBe('80');
  });
});

describe('XML_IE_EXCLUDE_VALS (#271)', () => {
  it('skips a value matching an entry', () => {
    const f = fieldsOf('<r><a>-</a><b>ok</b></r>', xmlDirs('xmlkv', d('XML_IE_EXCLUDE_VALS', '-')));
    expect(f['a']).toBeUndefined();
    expect(f['b']).toBe('ok');
  });

  it('drops only the matching values of a multivalue field', () => {
    const f = fieldsOf('<r><a>-</a><a>x</a></r>', xmlDirs('xmlkv', d('XML_IE_EXCLUDE_VALS', '-')));
    expect(f['a']).toBe('x');
  });

  it('matches * entries as globs, including across a multi-line value', () => {
    const f = fieldsOf(
      '<r><a>N/A (none)</a><b>line one\nline two</b><c>kept</c></r>',
      xmlDirs('xmlkv', d('XML_IE_EXCLUDE_VALS', 'N/A*,line*two')),
    );
    expect(f['a']).toBeUndefined();
    expect(f['b']).toBeUndefined();
    expect(f['c']).toBe('kept');
  });

  it('tests a many-star entry against a long value quickly (#344)', () => {
    // The value comes from the event, so the matcher's cost is the event's to
    // choose. Compiled to a backtracking regex this took seconds at 200 chars.
    const long = 'a'.repeat(10_000);
    const started = performance.now();
    const f = fieldsOf(
      `<r><a>${long}</a></r>`,
      xmlDirs(
        'xmlkv',
        d('XML_IE_EXCLUDE_VALS', '*a*a*a*a*b,*a*a*a*a*a*a*ab*'),
        d('XML_IE_MAX_EXTRACTED_VALUE_SIZE', '20000'),
        d('extraction_cutoff', '20000'),
      ),
    );
    expect(performance.now() - started).toBeLessThan(200);
    expect(f['a']).toBe(long);
  });
});

describe('XML_IE_SKIP_XML_ENCODED_VALS (#271)', () => {
  const raw = "<Event><EventData><Data Name='Cmd'>a &amp; b</Data><Data Name='User'>alice</Data></EventData></Event>";

  it('leaves an XML-encoded value out by default for xmlkv-winevt', () => {
    const f = fieldsOf(raw, xmlDirs('xmlkv-winevt'));
    expect(f['Cmd']).toBeUndefined();
    expect(f['User']).toBe('alice');
  });

  it('decodes and indexes it when false', () => {
    const f = fieldsOf(raw, xmlDirs('xmlkv-winevt', d('XML_IE_SKIP_XML_ENCODED_VALS', 'false')));
    expect(f['Cmd']).toBe('a & b');
  });

  it('does not apply to the other XML modes, which the spec does not scope it to', () => {
    expect(fieldsOf('<r><c>a &amp; b</c></r>', xmlDirs('xmlkv'))['c']).toBe('a & b');
  });

  it('treats an encoded attribute value the same way', () => {
    const f = fieldsOf("<Event><Provider Name='a&amp;b'/></Event>", xmlDirs('xmlkv-winevt'));
    expect(f['Provider_Name']).toBeUndefined();
  });
});

describe('XML_IE_MAX_EXTRACTED_VALUE_SIZE (#271)', () => {
  it('leaves a value over the default 1000 bytes out', () => {
    const f = fieldsOf(`<r><big>${'x'.repeat(1001)}</big><ok>${'y'.repeat(1000)}</ok></r>`, xmlDirs('xmlkv'));
    expect(f['big']).toBeUndefined();
    expect(f['ok']).toHaveLength(1000);
  });

  it('honours a lower limit, counted in bytes', () => {
    // "é" is two bytes in UTF-8, so three of them exceed a five-byte limit.
    const f = fieldsOf(
      '<r><a>abcde</a><b>ééé</b></r>',
      xmlDirs('xmlkv', d('XML_IE_MAX_EXTRACTED_VALUE_SIZE', '5')),
    );
    expect(f['a']).toBe('abcde');
    expect(f['b']).toBeUndefined();
  });
});

describe('extraction_cutoff (#271)', () => {
  it('extracts only what is complete within the first N bytes', () => {
    const raw = '<r><a>1</a><b>2</b></r>';
    // `<r><a>1</a>` is 11 bytes: `a` ends inside the cutoff, `b` does not.
    const f = fieldsOf(raw, xmlDirs('xmlkv', d('extraction_cutoff', '12')));
    expect(f['a']).toBe('1');
    expect(f['b']).toBeUndefined();
  });

  it('keeps an attribute whose start tag fits even when the element does not', () => {
    const f = fieldsOf('<r><a id="7">long text</a></r>', xmlDirs('xmlkv', d('extraction_cutoff', '14')));
    expect(f['id']).toBe('7');
    expect(f['a']).toBeUndefined();
  });

  it('counts CRLF line endings as the two bytes they are', () => {
    const raw = '<r>\r\n<a>1</a>\r\n<b>2</b></r>';
    // `<r>\r\n<a>1</a>` is 13 bytes.
    const f = fieldsOf(raw, xmlDirs('xmlkv', d('extraction_cutoff', '13')));
    expect(f['a']).toBe('1');
    expect(f['b']).toBeUndefined();
  });

  it('reads a document with an XML declaration, which cannot be wrapped', () => {
    const raw = '<?xml version="1.0"?><r><a>1</a><b>2</b></r>';
    const f = fieldsOf(raw, xmlDirs('xmlkv', d('extraction_cutoff', String(raw.indexOf('<b>')))));
    expect(f['a']).toBe('1');
    expect(f['b']).toBeUndefined();
  });

  it('defaults to 10000 bytes', () => {
    const filler = `<pad>${'p'.repeat(600)}</pad>`.repeat(17); // ~10.4 KB
    const f = fieldsOf(`<r><first>1</first>${filler}<last>2</last></r>`, xmlDirs('xmlkv'));
    expect(f['first']).toBe('1');
    expect(f['last']).toBeUndefined();
  });
});

describe('INDEXED_EXTRACTIONS = xml through the pipeline (#271)', () => {
  it('extracts at index time, with a trace entry', () => {
    const { result } = runPipeline(
      '<event><user>alice</user></event>\n',
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      '[st]\nINDEXED_EXTRACTIONS = xml\nXML_INDEXED_EXTRACTIONS_PIPELINE = typing\nKV_MODE = none\n',
      '',
      { perEventPipeline: false, captureOffsets: false },
    );
    const ev = result.events[0]!;
    expect(ev.fields['event.user']).toBe('alice');
    expect(ev.processingTrace.some((t) => t.processor === 'INDEXED_EXTRACTIONS(xml)')).toBe(true);
  });
});

describe('INDEXED_EXTRACTIONS xml family — line merging (#271)', () => {
  // Doc-derived. csv/tsv/psv/w3c/json turn line merging off by default because
  // each record is one line; an XML record is a document that spans lines, so
  // the XML modes keep the ordinary default and a BREAK_ONLY_BEFORE frames it.
  it('merges a multi-line record rather than splitting it per line', () => {
    const raw = '<Event>\n  <user>bob</user>\n</Event>\n<Event>\n  <user>amy</user>\n</Event>\n';
    const props =
      '[st]\nINDEXED_EXTRACTIONS = xml\nXML_INDEXED_EXTRACTIONS_PIPELINE = typing\nBREAK_ONLY_BEFORE = <Event>\n';
    const { result } = runPipeline(
      raw,
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      props,
      '',
      { perEventPipeline: false },
    );
    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.fields['Event.user'])).toEqual(['bob', 'amy']);
  });
});
