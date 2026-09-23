// ---------------------------------------------------------------------------
// xmlReader.test.ts
// The engine's own XML reader, which replaced DOMParser for KV_MODE = xml
// (#280). Doc-derived: the accept/reject cases follow the XML 1.0 (Fifth
// Edition) and Namespaces in XML 1.0 specs, cross-checked against what the
// previous DOMParser path accepted. Strictness is the point -- extractXml tells
// a fragment from a document, and XML from plain text, by whether this rejects.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { parseXmlDocument, xmlChildElements, xmlTextContent } from '../xmlReader';

describe('parseXmlDocument — accepts', () => {
  it('returns the root with attributes in source order and mixed children', () => {
    const root = parseXmlDocument('<a y="2" x=\'1\'>t<b/>u</a>');
    expect(root).not.toBeNull();
    expect(root!.name).toBe('a');
    expect(root!.attributes).toEqual([
      { name: 'y', value: '2' },
      { name: 'x', value: '1' },
    ]);
    expect(root!.children.map((c) => c.kind)).toEqual(['text', 'element', 'text']);
    expect(xmlTextContent(root!)).toBe('tu');
    expect(xmlChildElements(root!).map((e) => e.name)).toEqual(['b']);
  });

  it('normalises line endings, and attribute whitespace but not character references', () => {
    const root = parseXmlDocument('<a x="p\tq\r\nr&#10;s">l1\r\nl2\rl3</a>');
    expect(root!.attributes[0]!.value).toBe('p q r\ns');
    expect(xmlTextContent(root!)).toBe('l1\nl2\nl3');
  });

  it('accepts a prolog and trailing misc around the root', () => {
    const doc =
      '<?xml version="1.0" standalone="yes"?>\n<!-- c --><?pi x?>\n' +
      '<!DOCTYPE a SYSTEM "a.dtd" [<!ELEMENT a ANY><!-- ] > --><!ATTLIST a x CDATA "]">]>\n' +
      '<a/>\n<!-- t --><?pi?>\n';
    expect(parseXmlDocument(doc)?.name).toBe('a');
  });

  it('reads supplementary-plane characters, literal and referenced', () => {
    expect(xmlTextContent(parseXmlDocument('<a>\u{1F600}&#x1F600;</a>')!)).toBe('\u{1F600}\u{1F600}');
  });

  it('accepts non-ASCII names and the full NameChar set', () => {
    expect(parseXmlDocument('<é_x-1.2·/>')?.localName).toBe('é_x-1.2·');
  });

  it('scopes namespace bindings to the declaring element', () => {
    expect(parseXmlDocument('<a xmlns:p="u"><p:b/></a>')).not.toBeNull();
    expect(parseXmlDocument('<a><b xmlns:p="u"/><p:c/></a>')).toBeNull();
  });

  it('allows whitespace before the end of a tag', () => {
    expect(parseXmlDocument('<a >1</a >')).not.toBeNull();
  });

  it('is not bounded by the call stack', () => {
    const depth = 50_000;
    const root = parseXmlDocument('<a>'.repeat(depth) + '</a>'.repeat(depth));
    expect(root?.name).toBe('a');
  });
});

describe('parseXmlDocument — rejects', () => {
  it.each([
    ['empty input', ''],
    ['text outside the root', 'x<a/>'],
    ['trailing text', '<a/>x'],
    ['two roots', '<a/><b/>'],
    ['a declaration after whitespace', ' <?xml version="1.0"?><a/>'],
    ['a declaration with no version', '<?xml encoding="UTF-8"?><a/>'],
    ['a declaration inside an element', '<a><?xml version="1.0"?></a>'],
    ['a PI targeting xml', '<a><?XML x?></a>'],
    ['a PI with no space after its target', '<a><?pix?y?></a>'],
    ['an unterminated PI', '<a><?pi </a>'],
    ['a DOCTYPE with no name', '<!DOCTYPE><a/>'],
    ['an unterminated DOCTYPE', '<!DOCTYPE a [ <a/>'],
    ['a DOCTYPE with an unterminated literal', '<!DOCTYPE a SYSTEM "x><a/>'],
    ['a DOCTYPE with an unbalanced ]', '<!DOCTYPE a ]><a/>'],
    ['-- inside a comment', '<a><!-- x -- y --></a>'],
    ['a comment ending --->', '<a><!-- x ---></a>'],
    ['an unterminated comment', '<a><!-- x </a>'],
    ['an unterminated CDATA section', '<a><![CDATA[x</a>'],
    [']]> in text', '<a>x]]>y</a>'],
    ['an unterminated reference', '<a>&amp</a>'],
    ['an empty reference', '<a>&;</a>'],
    ['an undefined entity', '<a>&nbsp;</a>'],
    ['an inherited property as an entity name', '<a>&toString;</a>'],
    ['a malformed numeric reference', '<a>&#12a;</a>'],
    ['an empty hex reference', '<a>&#x;</a>'],
    ['a reference to NUL', '<a>&#0;</a>'],
    ['a reference to a surrogate', '<a>&#xD800;</a>'],
    ['a reference past U+10FFFF', '<a>&#x110000;</a>'],
    ['a literal control character', '<a>\u0001</a>'],
    ['a lone surrogate', '<a>\uD800</a>'],
    ['an unquoted attribute', '<a x=1/>'],
    ['< in an attribute value', '<a x="<"/>'],
    ['an unterminated attribute value', '<a x="1/>'],
    ['attributes run together', '<a x="1"y="2"/>'],
    ['a duplicate attribute', '<a x="1" x="2"/>'],
    ['an attribute with no =', '<a x/>'],
    ['a name starting with a digit', '<1a/>'],
    ['a mismatched end tag', '<a></b>'],
    ['an unclosed element', '<a>'],
    ['an end tag with trailing junk', '<a></a x>'],
    ['an unbound element prefix', '<p:a/>'],
    ['an unbound attribute prefix', '<a p:x="1"/>'],
    ['a name with two colons', '<a:b:c xmlns:a="u"/>'],
    ['a name with a leading colon', '<:a/>'],
    ['un-declaring a prefix', '<a xmlns:p=""/>'],
    ['binding the xmlns prefix', '<a xmlns:xmlns="u"/>'],
    ['binding xml to another namespace', '<a xmlns:xml="u"/>'],
    ['binding another prefix to the xml namespace', '<a xmlns:p="http://www.w3.org/XML/1998/namespace"/>'],
  ])('%s', (_label, input) => {
    expect(parseXmlDocument(input)).toBeNull();
  });

  it('allows xml to be bound to its own namespace', () => {
    expect(parseXmlDocument('<a xmlns:xml="http://www.w3.org/XML/1998/namespace"/>')).not.toBeNull();
  });
});
