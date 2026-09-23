// ---------------------------------------------------------------------------
// kvModeXml.test.ts
// `KV_MODE = xml`. This file used to run under jsdom, because extraction called
// `DOMParser` and Node has none -- which is exactly how nobody noticed that a
// Web Worker has none either, and the app extracted nothing (#280). It now runs
// under the engine default of `node`, the environment closest to the worker
// the pipeline really runs in, and one test pins that no DOM is present.
//
// Beyond the dotted-path naming (pinned by the `kvmode-xml` capture), these are
// doc-derived: they follow the XML 1.0 spec and what the earlier DOMParser-based
// implementation produced, not a Splunk capture.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

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
    const fields = fieldsOf(
      '<event><ts>2026-01-15T10:00:00Z</ts><user>alice</user><status>200</status></event>',
    );
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
    // `punct` is generated for every event by the annotation processor (#185),
    // so "nothing" means "nothing beyond it".
    const { punct: _punct, ...rest } = fieldsOf('plain text, no markup here');
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
    const { punct: _punct, ...rest } = fieldsOf(raw);
    expect(rest).toEqual({});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
