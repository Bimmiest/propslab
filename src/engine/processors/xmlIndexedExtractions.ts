/**
 * Index-time XML extraction: `INDEXED_EXTRACTIONS = xml`, `xmlkv` and
 * `xmlkv-winevt`, with the XML_IE_* filters and `extraction_cutoff` (#271).
 *
 * props.conf.spec says what the attributes do but not how the three modes
 * name their fields, so the naming here is borrowed rather than documented:
 *
 *   xml           -- KV_MODE = xml's convention (kvMode.ts) unchanged: leaves
 *                    by dotted element path from the root, root included;
 *                    attributes by bare name; a `Name` attribute names the
 *                    leaf it sits on and is also kept as `<tag>_Name`. The
 *                    path rule is the one part a capture (kvmode-xml) pins.
 *   xmlkv         -- the `xmlkv` search command's convention: a leaf is named
 *                    by its own tag, `<foo>bar</foo>` giving foo=bar.
 *                    Attributes by bare name, as above.
 *   xmlkv-winevt  -- the Windows event-log flavour: xmlkv naming, except that
 *                    `<Data Name="SubjectUserName">alice</Data>` gives
 *                    SubjectUserName=alice (the Name attribute is consumed as
 *                    the field name) and a Name attribute elsewhere gives
 *                    `<tag>_Name`, e.g. Provider_Name.
 *
 * Those are readings, not ground truth, and the tests say so.
 */

import type { ConfDirective, SplunkEvent, ValidationDiagnostic } from '../types';
import { setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';
import { parseXmlDocument, xmlChildElements, type XmlElement } from '../utils/xmlReader';
import { effectiveDirective, parseSplunkBool } from '../utils/directiveValues';
import { compileWildcard, type WildcardMatcher } from '../utils/wildcardMatch';

export type XmlIndexedMode = 'xml' | 'xmlkv' | 'xmlkv-winevt';

const PIPELINES = new Set(['structuredparsing', 'wineventlog', 'typing', 'exec']);
const WRAPPER_OPEN = '<_root_>';

interface XmlOptions {
  include: WildcardMatcher[];
  exclude: WildcardMatcher[];
  includeMv: WildcardMatcher[];
  excludeMv: WildcardMatcher[];
  excludeVals: WildcardMatcher[];
  skipEncoded: boolean;
  maxValueBytes: number;
  cutoffBytes: number;
}

/** One value the walk found, before any filter has looked at it. */
interface Candidate {
  name: string;
  value: string;
  /** The source form contained an entity or character reference. */
  encoded: boolean;
  /** Offset just past the markup that completes this value. */
  end: number;
}

export function extractXmlIndexed(
  events: SplunkEvent[],
  directives: ConfDirective[],
  mode: XmlIndexedMode,
  diagnostics?: ValidationDiagnostic[],
): SplunkEvent[] {
  const find = (key: string) => effectiveDirective(directives, key);

  // The spec makes XML_INDEXED_EXTRACTIONS_PIPELINE the switch for the XML
  // values of INDEXED_EXTRACTIONS, not only a routing choice: without it they
  // do nothing. Which pipeline it names is where the work runs, which has no
  // counterpart in a single simulated instance, so any valid value turns
  // extraction on here.
  const pipeline = find('XML_INDEXED_EXTRACTIONS_PIPELINE')?.value.trim().toLowerCase();
  if (pipeline === undefined || !PIPELINES.has(pipeline)) {
    diagnostics?.push({
      level: 'warning',
      message:
        `INDEXED_EXTRACTIONS = ${mode} extracts nothing: XML indexed extraction needs ` +
        'XML_INDEXED_EXTRACTIONS_PIPELINE set to structuredparsing, wineventlog, typing or exec.',
      file: 'props.conf',
      ...atDirective(find('XML_INDEXED_EXTRACTIONS_PIPELINE') ?? find('INDEXED_EXTRACTIONS')),
      directiveKey: 'XML_INDEXED_EXTRACTIONS_PIPELINE',
    });
    return events;
  }

  const opts = xmlOptions(find, mode);
  const processor = `INDEXED_EXTRACTIONS(${mode})`;

  return events.map((event) => {
    const candidates = walkEvent(event._raw, mode, opts.cutoffBytes);
    if (candidates === null) return event;

    // Filters, in the order the spec layers them: INCLUDE decides what is
    // eligible and EXCLUDE removes from that; the value filters then drop
    // individual values, so one bad value in a multivalue field does not take
    // the good ones with it.
    const kept = new Map<string, string[]>();
    for (const c of candidates) {
      if (!matchesAny(opts.include, c.name) || matchesAny(opts.exclude, c.name)) continue;
      if (matchesAny(opts.excludeVals, c.value)) continue;
      if (opts.skipEncoded && c.encoded) continue;
      if (utf8Length(c.value) > opts.maxValueBytes) continue;
      const values = kept.get(c.name);
      if (values) values.push(c.value);
      else kept.set(c.name, [c.value]);
    }

    const fields = { ...event.fields };
    const added: string[] = [];
    for (const [name, values] of kept) {
      const mv = matchesAny(opts.includeMv, name) && !matchesAny(opts.excludeMv, name);
      const first = values[0]!;
      setField(fields, name, mv && values.length > 1 ? values : first);
      added.push(name);
    }

    return {
      ...event,
      fields,
      processingTrace: [
        ...event.processingTrace,
        {
          processor,
          phase: 'index-time' as const,
          description: `Extracted ${added.length} XML fields`,
          fieldsAdded: added,
        },
      ],
    };
  });
}

function xmlOptions(find: (key: string) => ConfDirective | undefined, mode: XmlIndexedMode): XmlOptions {
  const list = (key: string, fallback: string) => wildcardList(find(key)?.value ?? fallback);
  const int = (key: string, fallback: number) => {
    const n = parseInt(find(key)?.value.trim() ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    include: list('XML_IE_INCLUDE', '*'),
    exclude: list('XML_IE_EXCLUDE', ''),
    includeMv: list('XML_IE_INCLUDE_MV', '*'),
    excludeMv: list('XML_IE_EXCLUDE_MV', ''),
    excludeVals: list('XML_IE_EXCLUDE_VALS', ''),
    // Default true, and the spec confines it to xmlkv-winevt.
    skipEncoded: mode === 'xmlkv-winevt' && parseSplunkBool(find('XML_IE_SKIP_XML_ENCODED_VALS')?.value, true),
    maxValueBytes: int('XML_IE_MAX_EXTRACTED_VALUE_SIZE', 1000),
    cutoffBytes: int('extraction_cutoff', 10000),
  };
}

/**
 * A comma-separated list whose entries accept `*` as a wildcard, compiled to
 * whole-string matchers. Entries may be double-quoted.
 *
 * Matched as globs rather than compiled to `.*` regexes (#344): the lists are
 * tested against values taken from the event (XML_IE_EXCLUDE_VALS), and a
 * backtracking regex made a handful of stars take seconds on a long value.
 */
function wildcardList(raw: string): WildcardMatcher[] {
  const out: WildcardMatcher[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim().replace(/^"(.*)"$/, '$1');
    if (!entry) continue;
    out.push(compileWildcard(entry));
  }
  return out;
}

function matchesAny(patterns: WildcardMatcher[], s: string): boolean {
  return patterns.some((matches) => matches(s));
}

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * The offset in the reader's end-of-line-normalised text at which the first
 * `bytes` UTF-8 bytes of `raw` end. The reader reports offsets after turning
 * CRLF into LF, so each CRLF before the cut is one character fewer there.
 */
function normalisedCutoff(raw: string, bytes: number): number {
  let used = 0;
  let index = 0;
  for (const ch of raw) {
    const size = utf8Length(ch);
    if (used + size > bytes) break;
    used += size;
    index += ch.length;
  }
  let crlf = 0;
  for (let i = raw.indexOf('\r\n'); i !== -1 && i + 1 < index; i = raw.indexOf('\r\n', i + 2)) crlf++;
  return index - crlf;
}

/**
 * Parse one event and list every candidate value within `extraction_cutoff`,
 * or null when the event is not XML.
 *
 * The cutoff is applied to where each value's markup ends rather than by
 * parsing the truncated text: a strict reader rejects a document cut off
 * mid-element outright, which would turn "read the first N bytes" into "read
 * nothing" for every event longer than N.
 */
function walkEvent(raw: string, mode: XmlIndexedMode, cutoffBytes: number): Candidate[] | null {
  // Same wrap-then-retry as KV_MODE = xml, so a fragment with several
  // top-level elements reads, and a document with a declaration still does.
  let root = parseXmlDocument(`${WRAPPER_OPEN}${raw}</_root_>`);
  let shift = WRAPPER_OPEN.length;
  let roots: XmlElement[];
  if (root !== null) {
    roots = xmlChildElements(root);
  } else {
    root = parseXmlDocument(raw);
    if (root === null) return null;
    shift = 0;
    roots = [root];
  }

  const limit = normalisedCutoff(raw, cutoffBytes) + shift;
  const out: Candidate[] = [];
  for (const el of roots) walk(el, mode, [], out);
  return out.filter((c) => c.end <= limit);
}

function walk(el: XmlElement, mode: XmlIndexedMode, parentPath: string[], out: Candidate[]): void {
  const tag = el.localName;
  const path = [...parentPath, tag];
  const children = xmlChildElements(el);
  const nameAttr = el.attributes.find((a) => a.name === 'Name');

  // A leaf's own text. Only a leaf has one: a parent's text is whitespace
  // between its children, or mixed content no mode names a field for.
  let value = '';
  let encoded = false;
  if (children.length === 0) {
    let text = '';
    for (const child of el.children) {
      if (child.kind !== 'text') continue;
      text += child.value;
      if (child.encoded) encoded = true;
    }
    value = text.trim();
  }

  // In xmlkv-winevt a Name attribute on a leaf with a value *is* that value's
  // field name, so it is consumed rather than also reported as `<tag>_Name`.
  // On an empty element (`<Provider Name='…'/>`) it names nothing and stays
  // Provider_Name. KV_MODE = xml reports both forms, and `xml` keeps that.
  const nameConsumed = mode === 'xmlkv-winevt' && value !== '' && Boolean(nameAttr?.value);

  for (const attr of el.attributes) {
    if (!attr.value) continue;
    if (attr === nameAttr && nameConsumed) continue;
    const useTagName = attr.name === 'Name' && mode !== 'xmlkv';
    out.push({
      name: useTagName ? `${tag}_Name` : attr.name,
      value: attr.value,
      encoded: attr.encoded === true,
      end: el.startTagEnd,
    });
  }

  for (const child of children) walk(child, mode, path, out);
  if (!value) return;

  // `||`, not `??`: an empty Name attribute names nothing, and the leaf falls
  // back to its path or tag rather than becoming a field called "".
  let name: string;
  if (mode === 'xml') name = nameAttr?.value || path.join('.');
  else if (mode === 'xmlkv-winevt') name = nameAttr?.value || tag;
  else name = tag;
  out.push({ name, value, encoded, end: el.end });
}
