import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { flattenJson, flattenArray } from '../utils/flattenJson';
import { hasField, setField, addFieldValue } from '../utils/fieldBag';
import { cleanFieldKey } from '../transforms/regexTransform';
import { parseXmlDocument, xmlChildElements, xmlTextContent, type XmlElement } from '../utils/xmlReader';

export function applyKvMode(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
): SplunkEvent[] {
  const kvModeDir = directives.find((d) => d.key === 'KV_MODE');
  const mode = kvModeDir?.value.trim().toLowerCase() ?? 'auto';

  if (mode === 'none') return events;

  // AUTO_KV_JSON (default true): in auto / auto_escaped mode Splunk also extracts
  // JSON automatically when the whole event is JSON-formatted.
  const autoKvJsonDir = directives.find((d) => d.key === 'AUTO_KV_JSON');
  const autoKvJson = autoKvJsonDir ? autoKvJsonDir.value.trim().toLowerCase() !== 'false' : true;

  // Collected across events: data that looks like JSON (see parseWholeJson) but
  // fails to parse. Surfaced as a single diagnostic so a malformed paste doesn't
  // silently yield partial/empty extractions with no explanation.
  const parseFailures: { line: number; error: string }[] = [];

  const result = events.map((event) => {
    const newFields = { ...event.fields };
    const added: string[] = [];
    let depthWarning = false;
    let parseError: string | undefined;

    switch (mode) {
      case 'json': {
        const r = extractJson(event._raw, newFields, added);
        depthWarning = r.depthLimited;
        parseError = r.parseError;
        break;
      }
      case 'xml':
        extractXml(event._raw, newFields, added);
        break;
      case 'multi':
        extractMultiKv(event._raw, newFields, added);
        break;
      case 'auto_escaped':
      case 'auto':
      default: {
        // Auto JSON extraction runs first so its leaf fields take precedence; the
        // key=value pass then fills in anything outside the JSON structure.
        if (autoKvJson) {
          const whole = parseWholeJson(event._raw);
          if (whole.kind === 'parsed') depthWarning = flattenParsed(whole.value, newFields, added);
          else if (whole.kind === 'invalid') parseError = whole.error;
        }
        extractKeyValue(event._raw, newFields, added, mode === 'auto_escaped');
        break;
      }
    }

    if (parseError) parseFailures.push({ line: event.lineNumbers.start, error: parseError });

    if (added.length === 0) return event;

    return {
      ...event,
      fields: newFields,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: `KV_MODE(${mode})`,
          phase: 'search-time' as const,
          description: `Extracted ${added.length} fields via KV_MODE=${mode}${depthWarning ? ' (depth limit reached — deeply nested fields omitted)' : ''}`,
          fieldsAdded: added,
        },
      ],
    };
  });

  const first = parseFailures[0];
  if (first !== undefined && diagnostics) {
    const n = parseFailures.length;
    // This is a problem with the raw event data, not the config — surface it under
    // the Raw Log panel and point `line` at the offending input line so the user
    // can jump straight to it.
    diagnostics.push({
      level: 'warning',
      file: 'raw',
      line: first.line,
      message: `KV_MODE = ${mode}: ${n} event${n === 1 ? '' : 's'} not valid JSON — JSON fields skipped (${first.error}).`,
      suggestion: 'Check for unquoted values, trailing commas, or placeholders like <ID>.',
    });
  }

  return result;
}

function* jsonObjectCandidates(raw: string): Generator<string, void, undefined> {
  let searchFrom = 0;
  let attempts = 0;
  while (attempts < 5) {
    const start = raw.indexOf('{', searchFrom);
    if (start === -1) return;
    let depth = 0;
    let inString = false;
    let escape = false;
    let found = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { yield raw.slice(start, i + 1); found = true; break; }
      }
    }
    if (!found) return; // no closing brace found — nothing further to try
    searchFrom = start + 1;
    attempts++;
  }
}

/**
 * Result of attempting to parse the whole event as JSON.
 * - `notJson`  — the event does not begin like a JSON object or array; it was never meant to be JSON.
 * - `invalid`  — it begins like JSON but `JSON.parse` rejected it (malformed data).
 * - `parsed`   — a valid JSON value (object or array).
 * Distinguishing `notJson` from `invalid` lets the caller warn about malformed JSON
 * without spamming a diagnostic for ordinary non-JSON events.
 */
type WholeJsonResult =
  | { kind: 'parsed'; value: unknown }
  | { kind: 'notJson' }
  | { kind: 'invalid'; error: string };

function parseWholeJson(raw: string): WholeJsonResult {
  const trimmed = raw.trim();
  // A leading `[` alone is not evidence of JSON: `[INFO] started` and other
  // bracketed log prefixes begin with one, and treating them as candidates
  // raised a "not valid JSON" warning on ordinary events (#289). Only an `[`
  // followed by something that can start a JSON value -- or close an empty
  // array -- is plausibly an array. That still admits a bracketed timestamp
  // (`[2026-01-15 10:00:00] msg` starts with a digit), which is commoner than
  // `[INFO]`, so an array must also end with `]`. The cost is that a truncated
  // array no longer warns; a truncated object still does, and whole-event
  // arrays are the rarer shape.
  const looksLikeJson =
    trimmed.startsWith('{') || (/^\[\s*[{["\d\-tfn\]]/.test(trimmed) && trimmed.endsWith(']'));
  if (!looksLikeJson) return { kind: 'notJson' };
  try {
    return { kind: 'parsed', value: JSON.parse(trimmed) };
  } catch (e) {
    return { kind: 'invalid', error: e instanceof Error ? e.message : 'invalid JSON' };
  }
}

/** Flatten an already-parsed JSON value (object or array). Returns true if depth limit hit. */
function flattenParsed(parsed: unknown, fields: Record<string, string | string[]>, added: string[]): boolean {
  if (Array.isArray(parsed)) return flattenArray(parsed, fields, added, '');
  if (parsed !== null && typeof parsed === 'object') {
    return flattenJson(parsed as Record<string, unknown>, fields, added);
  }
  return false;
}

interface JsonExtractResult {
  /** True if the depth limit was hit during flattening. */
  depthLimited: boolean;
  /** Set when the event looks like JSON but could not be parsed (for diagnostics). */
  parseError?: string;
}

function extractJson(
  raw: string,
  fields: Record<string, string | string[]>,
  added: string[],
): JsonExtractResult {
  // KV_MODE=json treats the event as structured JSON, so try to parse the whole
  // event first — this also covers top-level arrays.
  const whole = parseWholeJson(raw);
  if (whole.kind === 'parsed') return { depthLimited: flattenParsed(whole.value, fields, added) };

  // The whole event isn't valid JSON. Try ONLY the first/outermost embedded object.
  // This legitimately covers JSON wrapped in surrounding text ("level=info payload={...}")
  // or with trailing junk after a complete object.
  //
  // We deliberately do NOT descend into *nested* objects: recovering an inner
  // fragment (e.g. a deeply-nested "alert" block) and flattening it without its
  // ancestor path invents bare field names Splunk never produces (`action` instead
  // of `event.alert.action`) and silently drops every sibling and parent field.
  // Splunk's spath extracts nothing from JSON it cannot parse, so when the outer
  // object is malformed we extract nothing and report the parse error instead.
  const candidate = jsonObjectCandidates(raw).next().value;
  if (candidate !== undefined) {
    try {
      const obj: unknown = JSON.parse(candidate);
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
        return { depthLimited: flattenJson(obj as Record<string, unknown>, fields, added) };
      }
    } catch {
      // The outermost embedded object is itself malformed — fall through to the
      // diagnostic rather than scavenging a misleading inner fragment.
    }
  }

  return { depthLimited: false, parseError: whole.kind === 'invalid' ? whole.error : undefined };
}

function addMvField(fields: Record<string, string | string[]>, added: string[], key: string, value: string): void {
  // hasOwn-guarded + `__proto__`-safe so a key like `toString` is stored as a
  // real field instead of reading back the inherited Object.prototype member.
  addFieldValue(fields, key, value);
  // Record the key whether the field was created or gained another value: the
  // caller drops its whole field bag when `added` is empty, so an append that
  // went unrecorded was silently thrown away.
  if (!added.includes(key)) added.push(key);
}

function extractXml(raw: string, fields: Record<string, string | string[]>, added: string[]): void {
  // Wrap in a root element so fragments with several top-level elements (or
  // none) parse; the reader decodes entities, handles CDATA, and matches
  // multi-line content. It is the engine's own rather than DOMParser, which
  // exists in neither a Web Worker nor Node (see utils/xmlReader.ts, #280).
  let root = parseXmlDocument(`<_root_>${raw}</_root_>`);
  let wrapped = true;
  if (root === null) {
    // The wrapper is what makes a document with an XML declaration or DOCTYPE
    // malformed, so retry the raw text as-is in case it is already a valid
    // document. If that fails too, the event is not XML: extract nothing.
    root = parseXmlDocument(raw);
    if (root === null) return;
    wrapped = false;
  }

  // Walk from the *document's* root elements, not from the synthetic wrapper:
  // field names are dotted paths and `_root_` must not appear in any of them.
  const roots = wrapped ? xmlChildElements(root) : [root];
  for (const el of roots) {
    walkXmlElement(el, fields, added, []);
  }
}

function walkXmlElement(
  el: XmlElement,
  fields: Record<string, string | string[]>,
  added: string[],
  parentPath: string[],
): void {
  const tagName = el.localName;
  // Splunk names an XML field by its dotted path from the document root and
  // includes the root element itself, so `<event><user>…` extracts `event.user`
  // rather than `user` -- pinned by the `kvmode-xml` capture from 10.4.0.
  const path = [...parentPath, tagName];

  // Extract attributes. These keep their bare names rather than taking the path
  // prefix the element leaves get: no capture pins attribute naming, and the
  // WinEventLog convention below is the one behaviour here we do know.
  for (const attr of el.attributes) {
    // "Name" attribute on an element uses TagName_Name as field name (Windows EventLog convention).
    const fieldName = attr.name === 'Name' ? `${tagName}_Name` : attr.name;
    // Accumulate like the leaf-text path below: within one mode, repeated data
    // should not be first-wins in one place and multivalue in another.
    if (attr.value) addMvField(fields, added, fieldName, attr.value);
  }

  const children = xmlChildElements(el);

  if (children.length === 0) {
    // Leaf node — extract text content as a field.
    const value = xmlTextContent(el).trim();
    // For <Tag Name="fieldName">value</Tag>, use the Name attribute as the field name.
    const nameAttr = el.attributes.find((a) => a.name === 'Name')?.value;
    const fieldKey = nameAttr ?? path.join('.');
    if (value) {
      addMvField(fields, added, fieldKey, value);
    }
  } else {
    // Parent node — recurse into children.
    for (const child of children) {
      walkXmlElement(child, fields, added, path);
    }
  }
}

function extractKeyValue(
  raw: string,
  fields: Record<string, string | string[]>,
  added: string[],
  escaped: boolean,
): void {
  // Match key="value" and key='value' in ONE left-to-right pass, alternating on
  // the quote character, rather than a double-quoted sweep followed by a
  // single-quoted one.
  //
  // Two independent sweeps cannot be made correct by ordering, because each
  // quoting style can nest inside the other. Whichever ran first mined the
  // other's values: with a double-quoted-first order, `msg="an x='inner' thing"`
  // invented a field `x = inner` from text inside msg's value; reversing the
  // order just moved the bug to `msg='an x="inner" thing'`. A single scan
  // settles it by position — the quote that opens first consumes through its own
  // close, so whatever is nested inside is never a candidate.
  //
  // Key character class includes hyphen and dot (x-forwarded-for=..., both are
  // rewritten to underscores by key cleaning) but NOT colon: a colon re-anchors
  // the key, so `ip:port=1.2.3.4` names the field `port` — pinned by the
  // autokv-key-punctuation capture, and why `:` sits in the boundary class
  // instead. In auto_escaped mode the quoted branches allow backslash escapes
  // inside the value (e.g. key="say \"hi\""), which Splunk's auto_escaped
  // KV_MODE honours.
  const quoted = escaped
    ? /(?:^|[\s,;:])([\w.-]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g
    : /(?:^|[\s,;:])([\w.-]+)=(?:"([^"]*)"|'([^']*)')/g;
  // `=` is in the VALUE class: Splunk splits a bare pair on the first `=` and
  // takes the rest of the token, so `query=x=y=z` is one field worth `x=y=z`.
  // Excluding it truncated at the second `=` instead, which silently corrupts
  // query strings, base64 and filter expressions -- all routine in log data.
  const bare = /(?:^|[\s,;:])([\w.-]+)=([\w.:\-/\\@#+=]+)/g;

  // Working copy for the bare pass. Quoted key=value spans are blanked out here
  // so that a `key=value` substring *inside* a quoted value (e.g.
  // msg="error code=42") isn't mis-extracted as its own field. Blanking with
  // same-length spaces preserves the [\s,;] boundaries the bare pattern anchors on.
  let bareScan = raw;

  // Splunk's automatic KV extraction keeps the FIRST occurrence of a repeated
  // key and discards the rest -- `label=a label=b` is `label = "a"`, not a
  // multivalue field. Worth stating plainly because the opposite is the more
  // common intuition, and it is what this code did until the Splunk 10.4.0
  // capture (`kvmode-auto-repeated-key`) settled it.
  //
  // The "already extracted" guard still has to distinguish a key this pass has
  // seen from one an EARLIER processor wrote: automatic KV must not overwrite a
  // field that INDEXED_EXTRACTIONS or a REPORT already produced.
  const seenHere = new Set<string>();
  const record = (rawKey: string, value: string): void => {
    // Auto-KV names the field through the same key cleaning transforms use:
    // punctuation to underscores, then leading digits and underscores
    // stripped. Pinned by the autokv-key captures from 10.4.0 (#207):
    // `zone-found` becomes `zone_found`, `2fa` becomes `fa`, and a key that
    // cleans to nothing — including a purely numeric one — is discarded.
    // (An earlier reading, encoded in a #166 test, had leading digits
    // surviving; the capture disproved it.)
    const key = cleanFieldKey(rawKey);
    if (!key) return;
    if (seenHere.has(key)) return; // first occurrence wins
    if (hasField(fields, key)) return; // produced by an earlier processor — leave it alone
    setField(fields, key, value);
    seenHere.add(key);
    added.push(key);
  };

  // Both passes collect before either records, so "first wins" means first in
  // the EVENT rather than first in whichever pass happened to run. The quoted
  // sweep has to go first to blank its spans out of `bareScan`, so recording as
  // it goes would let a quoted pair beat a bare one that precedes it.
  const candidates: { at: number; key: string; value: string }[] = [];

  for (const match of raw.matchAll(quoted)) {
    const start = match.index ?? 0;
    bareScan =
      bareScan.slice(0, start) +
      ' '.repeat(match[0].length) +
      bareScan.slice(start + match[0].length);
    const key = match[1];
    // Exactly one of the two quote branches participates in a given match.
    let value = match[2] ?? match[3];
    if (key && value !== undefined) {
      if (escaped) value = value.replace(/\\(["'\\])/g, '$1');
      candidates.push({ at: start, key, value });
    }
  }

  for (const match of bareScan.matchAll(bare)) {
    const key = match[1];
    const value = match[2];
    if (key && value !== undefined) candidates.push({ at: match.index ?? 0, key, value });
  }

  candidates.sort((a, b) => a.at - b.at);
  for (const c of candidates) record(c.key, c.value);
}

/**
 * KV_MODE = multi (multikv): extract fields from a tabular event. The first
 * non-blank line is the column header; column boundaries are taken from the
 * start offset of each header token, and each subsequent row contributes one
 * value per column. Repeated rows accumulate into multivalue fields.
 *
 * This is a pragmatic subset of Splunk's multikv: it assumes space-aligned
 * columns and does not consult the multikv.conf table definitions.
 */
function extractMultiKv(raw: string, fields: Record<string, string | string[]>, added: string[]): void {
  const isSeparator = (line: string) => /^[\s\-=_|+]+$/.test(line);
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return;

  const [header, ...rows] = lines;
  if (header === undefined) return;
  const cols: Array<{ name: string; start: number }> = [];
  for (const m of header.matchAll(/\S+/g)) {
    cols.push({ name: m[0], start: m.index ?? 0 });
  }
  if (cols.length < 2) return;

  for (const line of rows) {
    if (isSeparator(line)) continue;

    // Prefer plain whitespace tokenization: most multikv input (ps/top/netstat
    // output) is left-aligned with variable-width values that do NOT line up
    // under the header token offsets. When the row splits into exactly one
    // token per column, that split is unambiguous — use it directly.
    const tokens = [...line.matchAll(/\S+/g)];
    if (tokens.length === cols.length) {
      for (const [c, col] of cols.entries()) {
        const value = tokens[c]?.[0];
        if (value) addMvField(fields, added, col.name, value);
      }
      continue;
    }

    // Otherwise fall back to fixed-width slicing at the header offsets. This
    // only produces sensible values when the row's columns are genuinely
    // aligned under the headers (or a value legitimately spans several tokens);
    // a mismatched token count means we cannot know the boundaries for certain.
    for (const [c, col] of cols.entries()) {
      const end = cols[c + 1]?.start ?? line.length;
      const value = line.slice(col.start, end).trim();
      if (value) addMvField(fields, added, col.name, value);
    }
  }
}
