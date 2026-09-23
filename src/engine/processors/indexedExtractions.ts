import type { ConfDirective, SplunkEvent, ValidationDiagnostic } from '../types';
import { flattenJson, flattenArray } from '../utils/flattenJson';
import { getField, setField } from '../utils/fieldBag';
import { safeRegex } from '../../utils/splunkRegex';
import { atDirective } from '../parser/provenance';
import { extractTimestamps } from './timestampExtractor';

export function applyIndexedExtractions(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
): SplunkEvent[] {
  const extractionDir = directives.find((d) => d.key === 'INDEXED_EXTRACTIONS');
  if (!extractionDir) return events;

  const mode = extractionDir.value.trim().toLowerCase();

  switch (mode) {
    case 'json':
      return extractJsonFields(events, directives);
    case 'csv':
      return extractDelimited(events, directives, ',', 'csv', diagnostics);
    case 'tsv':
      return extractDelimited(events, directives, '\t', 'tsv', diagnostics);
    case 'psv':
      return extractDelimited(events, directives, '|', 'psv', diagnostics);
    case 'w3c':
      return extractW3c(events);
    default:
      return events;
  }
}

function extractJsonFields(events: SplunkEvent[], directives: ConfDirective[]): SplunkEvent[] {
  const trimArrayBraces =
    directives.find((d) => d.key === 'JSON_TRIM_BRACES_IN_ARRAY_NAMES')?.value.trim().toLowerCase() === 'true';
  return events.map((event) => {
    try {
      const obj: unknown = JSON.parse(event._raw);
      if (typeof obj !== 'object' || obj === null) return event;

      const fields = { ...event.fields };
      const added: string[] = [];
      const sourceKeys: Record<string, string> = {};
      const opts = { stripLeadingUnderscore: true, sourceKeys, trimArrayBraces };
      const depthTruncated = Array.isArray(obj)
        ? flattenArray(obj as unknown[], fields, added, '', 0, opts)
        : flattenJson(obj as Record<string, unknown>, fields, added, '', 0, opts);

      return {
        ...event,
        fields,
        fieldSourceKeys: { ...event.fieldSourceKeys, ...sourceKeys },
        processingTrace: [
          ...event.processingTrace,
          {
            processor: 'INDEXED_EXTRACTIONS(json)',
            phase: 'index-time' as const,
            description: `Extracted ${added.length} JSON fields${depthTruncated ? ' (depth limit reached — deeply nested fields omitted)' : ''}`,
            fieldsAdded: added,
          },
        ],
      };
    } catch {
      return event;
    }
  });
}

/** How the fields of one line are split: the body's, or the header's. */
interface LineSyntax {
  /** Field separator. Ignored when `whitespaceDelimiter` is set. */
  delimiter: string;
  /** FIELD_DELIMITER = whitespace/ws: any run of spaces and tabs separates fields. */
  whitespaceDelimiter: boolean;
  /** Quote character, or null when quoting is disabled (FIELD_QUOTE = none). */
  quote: string | null;
}

/**
 * How one delimited (csv/tsv/psv) source is read, after the format's defaults
 * have been overridden by the structured-data attributes (#184, #272).
 */
interface DelimitedOptions extends LineSyntax {
  /**
   * How the header line is split. HEADER_FIELD_DELIMITER and
   * HEADER_FIELD_QUOTE override the body's syntax for that one line only;
   * without them the header is split exactly like the body.
   */
  header: LineSyntax;
  /** FIELD_HEADER_REGEX: marks the header line; the header is the text after the match. */
  fieldHeaderRegex: RegExp | null;
  /** HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS: characters header cleaning keeps. */
  acceptableSpecialChars: string;
  /** MISSING_VALUE_REGEX: a value matching this is absent, not a value. */
  missingValueRegex: RegExp | null;
  /** FIELD_NAMES: explicit header, for data with no header line. */
  fieldNames: string[] | null;
  /** HEADER_FIELD_LINE_NUMBER: 1-based header line; 0 locates it automatically. */
  headerLineNumber: number;
  /** PREAMBLE_REGEX: leading lines matching this are not data. */
  preambleRegex: RegExp | null;
  /** TIMESTAMP_FIELDS: extracted fields that together hold the timestamp. */
  timestampFields: string[] | null;
}

/**
 * Decode the single-character tokens the structured-header settings accept:
 * a literal character (optionally double-quoted), `\t`/`tab`, `space`, the
 * ASCII separator names (`fs`/`gs`/`rs`/`us`), `\xHH`, `whitespace`/`ws`
 * (FIELD_DELIMITER only) and `none` (FIELD_QUOTE only).
 */
function decodeDelimiterChar(raw: string): { char?: string; whitespace?: true; none?: true } | null {
  const v = raw.trim();
  switch (v.toLowerCase()) {
    case 'space':
      return { char: ' ' };
    case 'tab':
    case '\\t':
      return { char: '\t' };
    case 'fs':
      return { char: '\x1c' };
    case 'gs':
      return { char: '\x1d' };
    case 'rs':
      return { char: '\x1e' };
    case 'us':
      return { char: '\x1f' };
    case 'none':
      return { none: true };
    case 'whitespace':
    case 'ws':
      return { whitespace: true };
  }
  const hex = /^\\x([0-9a-f]{2})$/i.exec(v);
  if (hex) return { char: String.fromCharCode(parseInt(hex[1]!, 16)) };
  const unquoted = v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  return unquoted.length > 0 ? { char: unquoted.charAt(0) } : null;
}

/** A comma-separated list of names, each optionally double-quoted. */
function parseNameList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().replace(/^"(.*)"$/, '$1').trim();
    if (name) out.push(name);
  }
  return out;
}

function delimitedOptions(
  directives: ConfDirective[],
  defaultDelimiter: string,
  diagnostics?: ValidationDiagnostic[],
): DelimitedOptions {
  const find = (key: string) => directives.find((d) => d.key === key);

  const body: LineSyntax = { delimiter: defaultDelimiter, whitespaceDelimiter: false, quote: '"' };
  applySyntaxOverrides(body, find('FIELD_DELIMITER'), find('FIELD_QUOTE'));
  // The header starts from the body's syntax, not the format default, so a
  // FIELD_DELIMITER that applies to the whole file still splits the header
  // when no HEADER_FIELD_DELIMITER says otherwise.
  const header: LineSyntax = { ...body };
  applySyntaxOverrides(header, find('HEADER_FIELD_DELIMITER'), find('HEADER_FIELD_QUOTE'));

  const opts: DelimitedOptions = {
    ...body,
    header,
    fieldHeaderRegex: compileOption(find('FIELD_HEADER_REGEX'), 'The header was located as if it were unset.', diagnostics),
    // ASCII below 128 only, per the spec; anything else is not a character
    // the header processor can be told to keep.
    acceptableSpecialChars: [...(find('HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS')?.value.trim() ?? '')]
      .filter((ch) => ch.charCodeAt(0) < 128)
      .join(''),
    missingValueRegex: compileOption(find('MISSING_VALUE_REGEX'), 'No value was treated as missing.', diagnostics),
    fieldNames: null,
    headerLineNumber: 0,
    preambleRegex: null,
    timestampFields: null,
  };

  const namesDir = find('FIELD_NAMES');
  if (namesDir) {
    const names = parseNameList(namesDir.value);
    if (names.length > 0) opts.fieldNames = names;
  }

  const headerLineDir = find('HEADER_FIELD_LINE_NUMBER');
  if (headerLineDir) {
    const n = parseInt(headerLineDir.value.trim(), 10);
    if (Number.isFinite(n) && n > 0) opts.headerLineNumber = n;
  }

  opts.preambleRegex = compileOption(find('PREAMBLE_REGEX'), 'No preamble lines were skipped.', diagnostics);

  const timestampDir = find('TIMESTAMP_FIELDS');
  if (timestampDir) {
    const names = parseNameList(timestampDir.value);
    if (names.length > 0) opts.timestampFields = names;
  }

  return opts;
}

/** Apply a delimiter/quote directive pair to `syntax` in place. */
function applySyntaxOverrides(
  syntax: LineSyntax,
  delimiterDir: ConfDirective | undefined,
  quoteDir: ConfDirective | undefined,
): void {
  if (delimiterDir) {
    const decoded = decodeDelimiterChar(delimiterDir.value);
    if (decoded?.whitespace) syntax.whitespaceDelimiter = true;
    else if (decoded?.char !== undefined) {
      syntax.delimiter = decoded.char;
      syntax.whitespaceDelimiter = false;
    }
  }
  if (quoteDir) {
    const decoded = decodeDelimiterChar(quoteDir.value);
    if (decoded?.none) syntax.quote = null;
    else if (decoded?.char !== undefined) syntax.quote = decoded.char;
  }
}

/**
 * Compile a regex-valued attribute, or warn and return null. A pattern that
 * fails is reported rather than dropped silently: an unapplied regex looks
 * exactly like one that matched nothing.
 */
function compileOption(
  dir: ConfDirective | undefined,
  consequence: string,
  diagnostics?: ValidationDiagnostic[],
): RegExp | null {
  if (!dir) return null;
  const pattern = dir.value.trim();
  if (pattern === '') return null;
  const compiled = safeRegex(pattern);
  if (!compiled && diagnostics) {
    diagnostics.push({
      level: 'warning',
      message: `${dir.key} (${pattern}) could not be compiled safely (invalid regex or rejected as ReDoS-prone). ${consequence}`,
      file: 'props.conf',
      ...atDirective(dir),
      directiveKey: dir.key,
    });
  }
  return compiled;
}

/**
 * Compose `_time` from TIMESTAMP_FIELDS: the named fields' values, joined with
 * spaces in the declared order, parsed with the stanza's TIME_FORMAT/TZ. The
 * composed value starts at offset 0, so TIME_PREFIX and the lookahead — which
 * position a timestamp inside a raw event — do not apply to it.
 */
function applyTimestampFields(
  event: SplunkEvent,
  timestampFields: string[] | null,
  directives: ConfDirective[],
): SplunkEvent {
  if (!timestampFields) return event;

  const parts: string[] = [];
  for (const name of timestampFields) {
    const value = getField(event.fields, name);
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && first !== '') parts.push(first);
  }
  if (parts.length === 0) return event;
  const composed = parts.join(' ');

  const probe: SplunkEvent = { ...event, _raw: composed, _time: null, processingTrace: [] };
  const probeDirectives = directives.filter(
    (d) => d.key !== 'TIME_PREFIX' && d.key !== 'MAX_TIMESTAMP_LOOKAHEAD',
  );
  const parsed = extractTimestamps([probe], probeDirectives)[0]?._time ?? null;
  if (!parsed) return event;

  return {
    ...event,
    _time: parsed,
    processingTrace: [
      ...event.processingTrace,
      {
        processor: 'INDEXED_EXTRACTIONS(TIMESTAMP_FIELDS)',
        phase: 'index-time' as const,
        description: `_time parsed from ${timestampFields.join(', ')} ("${composed}")`,
        fieldsAdded: [],
        fieldsModified: ['_time'],
      },
    ],
  };
}

function extractDelimited(
  events: SplunkEvent[],
  directives: ConfDirective[],
  defaultDelimiter: string,
  mode: string,
  diagnostics?: ValidationDiagnostic[],
): SplunkEvent[] {
  if (events.length === 0) return events;

  const opts = delimitedOptions(directives, defaultDelimiter, diagnostics);

  // PREAMBLE_REGEX: a leading run of matching lines is not data. Only the
  // leading run — the attribute exists for banners before the header, and
  // dropping matching lines from the middle of the data would silently lose
  // records.
  let working = events;
  if (opts.preambleRegex) {
    let skip = 0;
    while (skip < working.length && opts.preambleRegex.test(working[skip]!._raw)) skip++;
    working = working.slice(skip);
  }

  // Where the field names come from decides how much of the input is data:
  // FIELD_NAMES names them directly and consumes nothing;
  // HEADER_FIELD_LINE_NUMBER names the exact header line; otherwise the first
  // content line is the header — a leading blank or comment line that became
  // its own event must be skipped, since assuming `events[0]` is the header
  // makes every field name garbage whenever the file opens with one.
  // FIELD_HEADER_REGEX, when set, is what identifies the header line instead:
  // such headers are typically decorated with a `#` prefix, which the
  // content-line rule would otherwise skip straight past.
  const clean = (name: string) => sanitizeHeaderName(name, opts.acceptableSpecialChars);
  const headerFrom = (raw: string) =>
    parseDelimitedLine(stripHeaderPrefix(raw, opts.fieldHeaderRegex), opts.header).map(clean);
  let headers: string[];
  let dataStart: number;
  if (opts.fieldNames) {
    headers = opts.fieldNames.map(clean);
    dataStart = 0;
  } else if (opts.headerLineNumber > 0) {
    const headerEvent = working[opts.headerLineNumber - 1];
    if (headerEvent === undefined) return events;
    headers = headerFrom(headerEvent._raw);
    dataStart = opts.headerLineNumber;
  } else {
    const fieldHeaderRegex = opts.fieldHeaderRegex;
    const headerIndex = fieldHeaderRegex
      ? working.findIndex((e) => fieldHeaderRegex.test(e._raw))
      : working.findIndex((e) => isContentLine(e._raw));
    const headerEvent = working[headerIndex];
    if (headerEvent === undefined) return events;
    headers = headerFrom(headerEvent._raw);
    dataStart = headerIndex + 1;
  }

  if (headers.length === 0) return events;

  // The header row (and any preamble before it) is consumed as metadata —
  // Splunk does not index it as an event.
  return working.slice(dataStart).map((event) => {
    const values = parseDelimitedLine(event._raw, opts);

    const fields = { ...event.fields };
    const added: string[] = [];

    for (const [i, header] of headers.entries()) {
      const value = values[i];
      // MISSING_VALUE_REGEX names the placeholder a source writes for "no
      // value"; indexing the placeholder would make an absent value
      // searchable as if it were data.
      if (header && value && !opts.missingValueRegex?.test(value)) {
        setField(fields, header, value);
        added.push(header);
      }
    }

    const extracted: SplunkEvent = {
      ...event,
      fields,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: `INDEXED_EXTRACTIONS(${mode})`,
          phase: 'index-time' as const,
          description: `Extracted ${added.length} fields from ${mode.toUpperCase()}`,
          fieldsAdded: added,
        },
      ],
    };

    return applyTimestampFields(extracted, opts.timestampFields, directives);
  });
}

function extractW3c(events: SplunkEvent[]): SplunkEvent[] {
  // W3C format: header line starts with #Fields:
  let headers: string[] = [];

  for (const event of events) {
    const fieldsMatch = event._raw.match(/^#Fields:\s*(.+)$/m);
    if (fieldsMatch) {
      headers = (fieldsMatch[1] ?? '').trim().split(/\s+/).map((name) => sanitizeHeaderName(name));
      break;
    }
  }

  if (headers.length === 0) return events;

  // Drop W3C directive/comment lines (#Version, #Fields, #Software, …) — they
  // are not indexed as events. A merged event carries its directive lines
  // inline, so test every line rather than only the first.
  return events
    .filter((event) => !isW3cDirectiveOnly(event._raw))
    .map((event) => {
    const values = parseW3cLine(event._raw);
    const fields = { ...event.fields };
    const added: string[] = [];

    for (const [i, header] of headers.entries()) {
      const value = values[i];
      if (header && value && value !== '-') {
        setField(fields, header, value);
        added.push(header);
      }
    }

    return {
      ...event,
      fields,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'INDEXED_EXTRACTIONS(w3c)',
          phase: 'index-time' as const,
          description: `Extracted ${added.length} W3C fields`,
          fieldsAdded: added,
        },
      ],
    };
  });
}

/** True for a line that carries data — not blank, not a `#` comment/directive. */
function isContentLine(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length > 0 && !trimmed.startsWith('#');
}

/** True when every line of the event is a W3C directive or blank. */
function isW3cDirectiveOnly(raw: string): boolean {
  return !raw.split(/\r?\n/).some(isContentLine);
}

/**
 * Normalise a structured-header token into the field name Splunk indexes.
 *
 * Splunk's structured-header processor replaces every character that is not
 * alphanumeric or `_` (props.conf.spec, `HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS`),
 * and strips the leading underscores it reserves for internal fields. Keeping
 * the raw token meant a W3C/IIS log surfaced `cs-uri-stem`, which is not the
 * name anyone can search for — `cs_uri_stem` is.
 *
 * `acceptable` is HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS: characters that
 * survive cleaning. The spec's wording exempts a space by default too; this
 * keeps replacing it, as it did before #272, because no capture settles the
 * point and changing every spaced header name on a doc reading alone is the
 * kind of confident wrong answer the fixtures exist to prevent. Naming a space
 * in the attribute keeps it.
 */
function sanitizeHeaderName(name: string, acceptable = ''): string {
  let out = '';
  for (const ch of name) out += /[A-Za-z0-9_]/.test(ch) || acceptable.includes(ch) ? ch : '_';
  return out.replace(/^_+/, '');
}

/**
 * FIELD_HEADER_REGEX: the header proper starts after the match, and the
 * matched decoration is not part of any field name. A line it does not match
 * (possible when HEADER_FIELD_LINE_NUMBER chose the line) is read whole.
 */
function stripHeaderPrefix(raw: string, fieldHeaderRegex: RegExp | null): string {
  const m = fieldHeaderRegex?.exec(raw);
  return m ? raw.slice(m.index + m[0].length) : raw;
}

/**
 * Split a W3C/IIS log line on unquoted whitespace, keeping double-quoted fields
 * (e.g. a User-Agent containing spaces) intact and stripping the surrounding
 * quotes. A plain `.split(/\s+/)` would tear quoted values into several columns.
 */
function parseW3cLine(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? m[2] ?? '');
  }
  return tokens;
}

function parseDelimitedLine(line: string, opts: LineSyntax): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  // Quoted fields preserve their interior whitespace; unquoted fields are trimmed.
  let fieldQuoted = false;

  const pushField = () => {
    fields.push(fieldQuoted ? current : current.trim());
    current = '';
    fieldQuoted = false;
  };

  const isDelimiter = (ch: string) =>
    opts.whitespaceDelimiter ? ch === ' ' || ch === '\t' : ch === opts.delimiter;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (opts.quote !== null && ch === opts.quote) {
      if (inQuotes && line[i + 1] === opts.quote) {
        current += opts.quote;
        i++;
      } else {
        inQuotes = !inQuotes;
        if (inQuotes) fieldQuoted = true;
      }
    } else if (isDelimiter(ch) && !inQuotes) {
      // A whitespace delimiter separates on the RUN: consecutive delimiter
      // characters (and a leading run) do not produce empty fields.
      if (!opts.whitespaceDelimiter || current.length > 0 || fieldQuoted) pushField();
    } else {
      current += ch;
    }
  }

  if (!opts.whitespaceDelimiter || current.length > 0 || fieldQuoted) pushField();
  return fields;
}
