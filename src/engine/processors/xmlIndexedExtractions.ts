/**
 * Index-time XML extraction: `INDEXED_EXTRACTIONS = xml`, `xmlkv` and
 * `xmlkv-winevt`, with the XML_IE_* filters and `extraction_cutoff`.
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

import type { ConfDirective, SplunkEvent } from '../types';
import { setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';
import { parseXmlDocument, xmlChildElements, type XmlElement } from '../utils/xmlReader';
import { walkXmlFields, type XmlCandidate as Candidate, type XmlNaming } from '../utils/xmlFields';
import { effectiveDirective, parseSplunkBool } from '../utils/directiveValues';
import { compileWildcard, type WildcardMatcher } from '../utils/wildcardMatch';
import type { RunContext } from '../runContext';

export type XmlIndexedMode = XmlNaming;

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

export function extractXmlIndexed(
  events: SplunkEvent[],
  directives: ConfDirective[],
  mode: XmlIndexedMode,
  ctx: RunContext,
): SplunkEvent[] {
  const { diagnostics } = ctx;
  const find = (key: string) => effectiveDirective(directives, key);

  // The spec makes XML_INDEXED_EXTRACTIONS_PIPELINE the switch for the XML
  // values of INDEXED_EXTRACTIONS, not only a routing choice: without it they
  // do nothing. Which pipeline it names is where the work runs, which has no
  // counterpart in a single simulated instance, so any valid value turns
  // extraction on here.
  const pipeline = find('XML_INDEXED_EXTRACTIONS_PIPELINE')?.value.trim().toLowerCase();
  if (pipeline === undefined || !PIPELINES.has(pipeline)) {
    diagnostics.push({
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

  // Caught per event so one pathological event costs only its own fields:
  // INDEXED_EXTRACTIONS is a batch-shaped stage (CSV headers), so an escaping
  // throw makes the pipeline fall back to the whole batch unmodified.
  const failures: { line: number; error: string }[] = [];

  const result = events.map((event) => {
    let candidates: Candidate[] | null;
    try {
      candidates = walkEvent(event._raw, mode, opts.cutoffBytes);
    } catch (err) {
      failures.push({ line: event.lineNumbers.start, error: err instanceof Error ? err.message : String(err) });
      return event;
    }
    if (candidates === null) return event;

    // Filters, in the order the spec layers them: INCLUDE decides what is
    // eligible and EXCLUDE removes from that; the value filters then drop
    // individual values, so one bad value in a multivalue field does not take
    // the good ones with it.
    // Every entry starts with the value that created it, so `values[0]` exists.
    const kept = new Map<string, [string, ...string[]]>();
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
      const [first] = values;
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

  const failed = failures[0];
  if (failed !== undefined) {
    const n = failures.length;
    diagnostics.push({
      level: 'error',
      file: 'raw',
      line: failed.line,
      message: `INDEXED_EXTRACTIONS = ${mode}: extraction failed on ${n} event${n === 1 ? '' : 's'}, which ${n === 1 ? 'keeps' : 'keep'} no XML fields (${failed.error}).`,
    });
  }
  return result;
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
 * Matched as globs rather than compiled to `.*` regexes: the lists are
 * tested against values taken from the event (XML_IE_EXCLUDE_VALS), where a
 * backtracking regex with a handful of stars takes seconds on a long value.
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
    // A code point above U+FFFF is a surrogate pair, two code units long.
    if (ch.length > 1) {
      n += 4;
      continue;
    }
    const unit = ch.charCodeAt(0);
    n += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
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
  for (const el of roots) walkXmlFields(el, mode, out);
  return out.filter((c) => c.end <= limit);
}
