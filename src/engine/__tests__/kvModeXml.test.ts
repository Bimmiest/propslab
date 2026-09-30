// ---------------------------------------------------------------------------
// kvModeXml.test.ts
// `KV_MODE = xml`. Runs under the engine default of `node`, the environment
// closest to the worker the pipeline really runs in, and one test pins that no
// DOM is present: neither a Web Worker nor Node has `DOMParser`.
//
// Beyond the dotted-path naming (pinned by the `kvmode-xml` capture), these are
// doc-derived: they follow the XML 1.0 spec, not a Splunk capture.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';
import { expectLinearWork } from '../../test/scanWork';

const metadata: EventMetadata = {
  index: 'main',
  host: 'test-host',
  source: 'test-source',
  sourcetype: 'xmltest',
};

function fieldsOf(raw: string, props = 'SHOULD_LINEMERGE = false\nKV_MODE = xml\n') {
  const { result } = runPipeline(raw, metadata, `[xmltest]\n${props}`, '', {
    perEventPipeline: false,
    captureOffsets: false,
  });
  return result.events[0]?.fields ?? {};
}

describe('KV_MODE = xml', () => {
  it('names a field by its dotted path from the document root (#171)', () => {
    const fields = fieldsOf('<event><ts>2026-01-15T10:00:00Z</ts><user>alice</user><status>200</status></event>');
    // The wrapper element is part of the name -- `event.user`, not `user`. This
    // is what the Splunk 10.4.0 capture records.
    expect(fields).toMatchObject({
      'event.ts': '2026-01-15T10:00:00Z',
      'event.user': 'alice',
      'event.status': '200',
    });
  });

  it('carries the whole ancestor chain, not just the parent', () => {
    const fields = fieldsOf('<a><b><c>deep</c></b></a>');
    expect(fields['a.b.c']).toBe('deep');
  });

  it('extracts nothing from text that is not XML', () => {
    // `punct` is generated for every event by the annotation processor,
    // and `timestamp=none` for every event with no timestamp in it, so
    // "nothing" means "nothing beyond those".
    const { punct: _punct, timestamp: _timestamp, ...rest } = fieldsOf('plain text, no markup here');
    expect(rest).toEqual({});
  });

  it('keeps the WinEventLog Name-attribute convention unprefixed', () => {
    // <Data Name="x">v</Data> is named by its Name attribute rather than by its
    // path, which is how Windows event XML is read.
    const fields = fieldsOf('<Event><EventData><Data Name="TargetUser">bob</Data></EventData></Event>');
    expect(fields['TargetUser']).toBe('bob');
  });

  it('accumulates a repeated element into a multivalue field', () => {
    const fields = fieldsOf('<r><item>one</item><item>two</item></r>');
    expect(fields['r.item']).toEqual(['one', 'two']);
  });

  it('does not leak the synthetic wrapper into a fragment field name', () => {
    // Two sibling roots make the input a fragment rather than a document, which
    // is the case the internal `<_root_>` wrapper exists for.
    const fields = fieldsOf('<one>1</one><two>2</two>');
    expect(fields).toMatchObject({ one: '1', two: '2' });
    expect(Object.keys(fields).some((k) => k.includes('_root_'))).toBe(false);
  });

  it('extracts with no DOMParser anywhere (#280)', () => {
    // Under `node` there is none to begin with; the stub keeps the point made
    // even if this file is ever moved to an environment that has one.
    expect('DOMParser' in globalThis).toBe(false);
    vi.stubGlobal('DOMParser', undefined);
    expect(fieldsOf('<event><user>alice</user></event>')['event.user']).toBe('alice');
  });

  it('decodes the predefined entities, character references and CDATA', () => {
    const fields = fieldsOf(
      '<e><q>a &lt;b&gt; &amp; &apos;c&apos; &quot;d&quot;</q><n>&#65;&#x42;</n><c><![CDATA[<raw> & more]]></c></e>',
    );
    expect(fields).toMatchObject({
      'e.q': 'a <b> & \'c\' "d"',
      'e.n': 'AB',
      'e.c': '<raw> & more',
    });
  });

  it('skips comments and processing instructions inside content', () => {
    const fields = fieldsOf('<e><!-- note --><v>1<?pi data?>2</v></e>');
    expect(fields['e.v']).toBe('12');
  });

  it('reads a whole document with a declaration, which the fragment wrapper cannot hold', () => {
    const fields = fieldsOf('<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE e><e><v>1</v></e>');
    expect(fields['e.v']).toBe('1');
  });

  it('names elements by local name and keeps attribute names qualified', () => {
    const fields = fieldsOf('<ns:e xmlns:ns="urn:x" xml:lang="en"><ns:v>1</ns:v></ns:e>');
    expect(fields).toMatchObject({ 'e.v': '1', 'xmlns:ns': 'urn:x', 'xml:lang': 'en' });
  });

  it('extracts attributes under their bare names, renaming a Name attribute', () => {
    const fields = fieldsOf(
      '<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Name="Svc" Guid="{1}"/></System></Event>',
    );
    expect(fields).toMatchObject({
      xmlns: 'http://schemas.microsoft.com/win/2004/08/events/event',
      Provider_Name: 'Svc',
      Guid: '{1}',
    });
  });

  it.each([
    ['a mismatched end tag', '<a><b>1</a></b>'],
    ['an unclosed element', '<a><b>1</b>'],
    ['an undefined entity', '<a><b>&nbsp;</b></a>'],
    ['a bare ampersand', '<a><b>x & y</b></a>'],
    ['an unbound namespace prefix', '<p:a><b>1</b></p:a>'],
    ['a duplicate attribute', '<a x="1" x="2"><b>1</b></a>'],
  ])('extracts nothing from %s, as a strict parser rejects it outright', (_label, raw) => {
    const { punct: _punct, timestamp: _timestamp, ...rest } = fieldsOf(raw);
    expect(rest).toEqual({});
  });
});

describe('KV_MODE = xml — an empty Name attribute (#483)', () => {
  // A Name attribute names the leaf it sits on only when it says something: an
  // empty one names nothing, so the leaf keeps its dotted path rather than
  // becoming a field called "" (INDEXED_EXTRACTIONS = xml already did this).
  it('falls back to the path for <Data Name="">v</Data>', () => {
    const fields = fieldsOf('<Event><Data Name="">v</Data></Event>');
    expect(fields['Event.Data']).toBe('v');
    expect(Object.keys(fields)).not.toContain('');
  });

  it('still names a leaf by a non-empty Name attribute', () => {
    expect(fieldsOf('<Event><Data Name="User">v</Data></Event>')['User']).toBe('v');
  });
});

describe('KV_MODE = xml — an event with very many elements (#480)', () => {
  // The default TRUNCATE = 10000 hides this; 0 lifts it. Distinct element names
  // were checked against a growing list, which took seconds at this size.
  const props = 'SHOULD_LINEMERGE = false\nTRUNCATE = 0\nKV_MODE = xml\n';

  // Counted, not timed (#507): the length scanned by array and string built-ins
  // must not much more than double when the event's size does. A check of each
  // new name against a growing list adds the whole list every time.
  const elements = (n: number) => {
    let body = '';
    for (let i = 0; i < n; i++) body += `<e${i}>v</e${i}>`;
    return `<r>${body}</r>`;
  };
  const attributes = (n: number) => {
    let attrs = '';
    for (let i = 0; i < n; i++) attrs += ` a${i}="v"`;
    return `<r${attrs}/>`;
  };

  it('extracts many distinct elements in linear work', () => {
    expectLinearWork((n) => {
      const raw = elements(n);
      return () => void fieldsOf(raw, props);
    }, 5_000);
    const fields = fieldsOf(elements(40_000), props);
    expect(fields['r.e0']).toBe('v');
    expect(fields['r.e39999']).toBe('v');
  });

  it('reads an element with many distinct attributes in linear work', () => {
    expectLinearWork((n) => {
      const raw = attributes(n);
      return () => void fieldsOf(raw, props);
    }, 5_000);
    expect(fieldsOf(attributes(40_000), props)['a0']).toBe('v');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
