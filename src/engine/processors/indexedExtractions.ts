import type { ConfDirective, SplunkEvent } from '../types';
import { flattenJson, flattenArray } from '../utils/flattenJson';
import { deleteField, getField, setField } from '../utils/fieldBag';
import { safeRegex, validateRegex, type SplunkRegex } from '../../utils/splunkRegex';
import { atDirective } from '../parser/provenance';
import { EXTRA_TIME_FIELD_NAMES, extractTimestamps } from './timestampExtractor';
import { extractXmlIndexed } from './xmlIndexedExtractions';
import { effectiveBool, effectiveDirective } from '../utils/directiveValues';
import { withDiagnostics, type RunContext, type DiagnosticSink } from '../runContext';

export function applyIndexedExtractions(
  events: SplunkEvent[],
  directives: ConfDirective[],
  /** `ctx.now` is the index time TIMESTAMP_FIELDS parsing uses, and falls back to. */
  ctx: RunContext,
  /**
   * The text `events` were broken from, which their line numbers point into.
   * The delimited formats read back from it the line break inside a quoted
   * value that line breaking removed.
   */
  input?: string,
): SplunkEvent[] {
  const extractionDir = effectiveDirective(directives, 'INDEXED_EXTRACTIONS');
  if (!extractionDir) return events;

  const mode = extractionDir.value.trim().toLowerCase();

  switch (mode) {
    case 'json':
      return extractJsonFields(events, directives, ctx);
    case 'csv':
      return extractDelimited(events, directives, { delimiter: ',', mode: 'csv', input }, ctx);
    case 'tsv':
      return extractDelimited(events, directives, { delimiter: '\t', mode: 'tsv', input }, ctx);
    case 'psv':
      return extractDelimited(events, directives, { delimiter: '|', mode: 'psv', input }, ctx);
    case 'w3c':
      return extractW3c(events, directives, ctx);
    case 'xml':
    case 'xmlkv':
    case 'xmlkv-winevt':
      return extractXmlIndexed(events, directives, mode, ctx);
    default:
      return events;
  }
}

function extractJsonFields(events: SplunkEvent[], directives: ConfDirective[], ctx: RunContext): SplunkEvent[] {
  const trimArrayBraces = effectiveBool(directives, 'JSON_TRIM_BRACES_IN_ARRAY_NAMES', false);
  // Events that are not valid JSON, reported once at the end (as KV_MODE = json
  // does) so a malformed file is not silently read as "no fields".
  const parseFailures: { line: number; error: string }[] = [];

  const result = events.map((event) => {
    const parsed = parseJsonEvent(event._raw);
    if (parsed.kind === 'invalid') {
      parseFailures.push({ line: event.lineNumbers.start, error: parsed.error });
      return event;
    }
    const obj = parsed.value;
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
  });

  const first = parseFailures[0];
  if (first !== undefined) {
    const n = parseFailures.length;
    // A problem with the raw event data, not the config: surface it under the
    // Raw Log panel, pointing at the first offending line.
    ctx.diagnostics.push({
      level: 'warning',
      file: 'raw',
      line: first.line,
      message: `INDEXED_EXTRACTIONS = json: ${n} event${n === 1 ? '' : 's'} not valid JSON — JSON fields skipped (${first.error}).`,
      suggestion: 'Check for unquoted values, trailing commas, or placeholders like <ID>.',
    });
  }
  return applyTimestampFields(result, directives, ctx);
}

/**
 * Parse one event as JSON. A leading byte order mark and surrounding
 * whitespace are not part of the document (a UTF-8 file often starts with a
 * BOM, and the line breaker can leave a trailing newline), so they are removed
 * first. Only the parse itself is guarded: a failure in the flattening that
 * follows is a bug, not bad input, and must not be swallowed here.
 */
function parseJsonEvent(raw: string): { kind: 'parsed'; value: unknown } | { kind: 'invalid'; error: string } {
  const text = raw.replace(/^\uFEFF/, '').trim();
  try {
    return { kind: 'parsed', value: JSON.parse(text) };
  } catch (e) {
    return { kind: 'invalid', error: e instanceof Error ? e.message : 'invalid JSON' };
  }
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
 * have been overridden by the structured-data attributes.
 */
interface DelimitedOptions extends LineSyntax {
  /**
   * How the header line is split. HEADER_FIELD_DELIMITER and
   * HEADER_FIELD_QUOTE override the body's syntax for that one line only;
   * without them the header is split exactly like the body.
   */
  header: LineSyntax;
  /** FIELD_HEADER_REGEX: marks the header line; the header is the text after the match. */
  fieldHeaderRegex: SplunkRegex | null;
  /** HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS: characters header cleaning keeps. */
  acceptableSpecialChars: string;
  /** MISSING_VALUE_REGEX: true for a value that is absent, not a value. */
  isMissingValue: ((value: string) => boolean) | null;
  /** FIELD_NAMES: explicit header, for data with no header line. */
  fieldNames: string[] | null;
  /** HEADER_FIELD_LINE_NUMBER: 1-based header line; 0 locates it automatically. */
  headerLineNumber: number;
  /** PREAMBLE_REGEX: leading lines matching this are not data. */
  preambleRegex: SplunkRegex | null;
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
  if (/^\\x[0-9a-f]{2}$/i.test(v)) return { char: String.fromCharCode(parseInt(v.slice(2), 16)) };
  const unquoted = v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  return unquoted.length > 0 ? { char: unquoted.charAt(0) } : null;
}

/** A comma-separated list of names, each optionally double-quoted. */
function parseNameList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = part
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim();
    if (name) out.push(name);
  }
  return out;
}

function delimitedOptions(
  directives: ConfDirective[],
  defaultDelimiter: string,
  diagnostics?: DiagnosticSink,
): DelimitedOptions {
  const find = (key: string) => effectiveDirective(directives, key);

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
    fieldHeaderRegex: compileOption(
      find('FIELD_HEADER_REGEX'),
      'The header was located as if it were unset.',
      diagnostics,
    ),
    // ASCII below 128 only, per the spec; anything else is not a character
    // the header processor can be told to keep.
    acceptableSpecialChars: Array.from(find('HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS')?.value.trim() ?? '')
      .filter((ch) => ch.charCodeAt(0) < 128)
      .join(''),
    isMissingValue: wholeValueTest(
      compileOption(find('MISSING_VALUE_REGEX'), 'No value was treated as missing.', diagnostics),
    ),
    fieldNames: null,
    headerLineNumber: 0,
    preambleRegex: null,
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
  diagnostics?: DiagnosticSink,
): SplunkRegex | null {
  if (!dir) return null;
  const pattern = dir.value.trim();
  if (pattern === '') return null;
  const compiled = safeRegex(pattern);
  if (!compiled && diagnostics) {
    diagnostics.push({
      level: 'warning',
      message: `${dir.key} (${pattern}) does not compile (${validateRegex(pattern) ?? 'invalid regex'}). ${consequence}`,
      file: 'props.conf',
      ...atDirective(dir),
      directiveKey: dir.key,
    });
  }
  return compiled;
}

/**
 * MISSING_VALUE_REGEX matches a whole value, not part of one (#449). Getting
 * Data In: "If Splunk software finds data that matches the specified regular
 * expression in the structured data file, it considers the value for the field
 * in the row to be empty." So with `-`, a lone dash is missing while
 * `2026-01-15` and `a-b` are values. The pattern is anchored at both ends; one
 * that cannot be wrapped in an anchored group (an unterminated `\Q`, say)
 * must instead match from the first character to the last.
 */
function wholeValueTest(regex: SplunkRegex | null): ((value: string) => boolean) | null {
  if (!regex) return null;
  const anchored = safeRegex(`\\A(?:${regex.source})\\z`, regex.flags);
  if (anchored) return (value) => anchored.test(value);
  return (value) => {
    const m = regex.exec(value);
    return m?.index === 0 && m.end === value.length;
  };
}

/**
 * TIMESTAMP_FIELDS: `_time` read from the named fields rather than from the
 * event. props.conf.spec: "Some CSV and structured files have their timestamp
 * encompass multiple fields in the event separated by delimiters", so the
 * values are joined with a space in the declared order, then parsed with the
 * stanza's TIME_FORMAT and TZ. The joined value starts at offset 0, so
 * TIME_PREFIX and the lookahead, which place a timestamp inside a raw event, do
 * not apply to it.
 *
 * It applies to json and w3c as it does to the delimited formats. When the
 * value does not parse, or none of the fields has one, the event takes the
 * previous event's `_time`, or the time of indexing when there is no previous
 * event, and the rest of the event is not searched for another timestamp
 * (#444). The values are parsed as one batch so that each inherits from the
 * one before it, as the timestamp stage's events do.
 */
function applyTimestampFields(events: SplunkEvent[], directives: ConfDirective[], ctx: RunContext): SplunkEvent[] {
  const names = parseNameList(effectiveDirective(directives, 'TIMESTAMP_FIELDS')?.value ?? '');
  if (names.length === 0) return events;

  const probes = events.map((event) => ({
    ...event,
    _raw: timestampFieldsValue(event.fields, names),
    _time: null,
    fields: {},
    processingTrace: [],
  }));
  const probeDirectives = directives.filter((d) => d.key !== 'TIME_PREFIX' && d.key !== 'MAX_TIMESTAMP_LOOKAHEAD');
  // The timestamp stage has already said what is wrong with the stanza's
  // timestamp settings (an unknown TZ, a stamp out of bounds); parsing the
  // named values does not say it again.
  const quiet = withDiagnostics(ctx, ctx.diagnostics.deduplicating(ctx.diagnostics.list));
  const placed = extractTimestamps(probes, probeDirectives, quiet);
  return events.map((event, i) => {
    const probe = placed[i];
    return probe ? settleTimestamp(event, probe, names) : event;
  });
}

/** The named fields' values, joined with a space in the order named. A field with no value is left out. */
function timestampFieldsValue(fields: SplunkEvent['fields'], names: string[]): string {
  const parts: string[] = [];
  for (const name of names) {
    const value = getField(fields, name);
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && first !== '') parts.push(first);
  }
  return parts.join(' ');
}

/**
 * `event` with the `_time` parsing its TIMESTAMP_FIELDS value (`probe`)
 * settled on. A value that gave no timestamp fell back the way the timestamp
 * stage does, and the event then carries the fallback's time fields
 * (`timestamp=none`) in place of the ones the stage wrote for a timestamp it
 * found elsewhere in the event.
 */
function settleTimestamp(event: SplunkEvent, probe: SplunkEvent, names: string[]): SplunkEvent {
  const [step] = probe.processingTrace;
  const read = step?.timeSource === 'TIME_FORMAT' || step?.timeSource === 'auto-recognition';
  const named = names.join(', ');
  return {
    ...event,
    _time: probe._time,
    fields: read ? event.fields : withTimeFields(event, probe.fields),
    processingTrace: [
      ...event.processingTrace,
      {
        processor: 'INDEXED_EXTRACTIONS(TIMESTAMP_FIELDS)',
        phase: 'index-time' as const,
        description: read
          ? `_time parsed from ${named} ("${probe._raw}")`
          : `No timestamp read from ${named} ("${probe._raw}"): ${step?.description}`,
        timeSource: step?.timeSource,
        fieldsAdded: [],
        fieldsModified: ['_time'],
      },
    ],
  };
}

/**
 * `event`'s fields with the timestamp stage's time fields replaced by
 * `timeFields`. What the stage wrote describes a timestamp it read from the
 * whole event, which TIMESTAMP_FIELDS overrules. A column the extraction wrote
 * under one of those names is data, and stays.
 */
function withTimeFields(event: SplunkEvent, timeFields: SplunkEvent['fields']): SplunkEvent['fields'] {
  const extracted = new Set(
    event.processingTrace
      .filter((step) => step.processor.startsWith('INDEXED_EXTRACTIONS('))
      .flatMap((step) => step.fieldsAdded ?? []),
  );
  const fields = { ...event.fields };
  for (const name of EXTRA_TIME_FIELD_NAMES) {
    if (!extracted.has(name)) deleteField(fields, name);
  }
  for (const [name, value] of Object.entries(timeFields)) {
    if (!extracted.has(name)) setField(fields, name, value);
  }
  return fields;
}

/** What one delimited format needs besides the stanza: its default delimiter, its name, and the input. */
interface DelimitedSource {
  delimiter: string;
  mode: string;
  /** See `applyIndexedExtractions`. */
  input: string | undefined;
}

function extractDelimited(
  events: SplunkEvent[],
  directives: ConfDirective[],
  source: DelimitedSource,
  ctx: RunContext,
): SplunkEvent[] {
  if (events.length === 0) return events;
  const { mode } = source;

  const opts = delimitedOptions(directives, source.delimiter, ctx.diagnostics);

  // PREAMBLE_REGEX: a leading run of matching lines is not data. Only the
  // leading run — the attribute exists for banners before the header, and
  // dropping matching lines from the middle of the data would silently lose
  // records.
  let skip = 0;
  if (opts.preambleRegex) {
    for (const e of events) {
      if (!opts.preambleRegex.test(e._raw)) break;
      skip++;
    }
  }
  const working = events.slice(skip);

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
  // Where the data rows start, as an index into `events`.
  let dataStart: number;
  if (opts.fieldNames) {
    headers = opts.fieldNames.map(clean);
    dataStart = skip;
  } else if (opts.headerLineNumber > 0) {
    // HEADER_FIELD_LINE_NUMBER counts the lines of the input, blank lines and
    // preamble lines included (#449), so the header is the event that starts
    // on that line, not the nth event, and the lines before it are not
    // indexed. When that line is preamble, or no event starts on it, there is
    // no header: the lines after it are indexed with no fields.
    const line = opts.headerLineNumber;
    const headerIndex = events.findIndex((e) => e.lineNumbers.start === line);
    const headerEvent = headerIndex < skip ? undefined : events[headerIndex];
    if (headerEvent === undefined) return working.filter((e) => e.lineNumbers.start > line);
    headers = headerFrom(headerEvent._raw);
    dataStart = headerIndex + 1;
  } else {
    const fieldHeaderRegex = opts.fieldHeaderRegex;
    const headerIndex = fieldHeaderRegex
      ? working.findIndex((e) => fieldHeaderRegex.test(e._raw))
      : working.findIndex((e) => isContentLine(e._raw));
    const headerEvent = working[headerIndex];
    if (headerEvent === undefined) return events;
    headers = headerFrom(headerEvent._raw);
    dataStart = skip + headerIndex + 1;
  }

  if (headers.length === 0) return events;

  // The header row (and any preamble before it) is consumed as metadata —
  // Splunk does not index it as an event.
  const rows = rejoinQuotedRows(events.slice(dataStart), opts.quote, source).map((event) => {
    const values = parseDelimitedLine(event._raw, opts);

    const fields = { ...event.fields };
    const added: string[] = [];

    for (const [i, header] of headers.entries()) {
      const value = values[i];
      // MISSING_VALUE_REGEX names the placeholder a source writes for "no
      // value"; indexing the placeholder would make an absent value
      // searchable as if it were data.
      if (header && value && !opts.isMissingValue?.(value)) {
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
          processor: `INDEXED_EXTRACTIONS(${mode})`,
          phase: 'index-time' as const,
          description: `Extracted ${added.length} fields from ${mode.toUpperCase()}`,
          fieldsAdded: added,
        },
      ],
    };
  });
  return applyTimestampFields(rows, directives, ctx);
}

/** A row being put back together from the events line breaking split it into. */
interface PendingRow {
  first: SplunkEvent;
  last: SplunkEvent;
  raw: string;
}

/**
 * The data rows, with a row whose quoted value holds a line break put back
 * together (#449). Line breaking runs before this and splits such a row at
 * the break, so while a quote is open the next event continues the row, joined
 * by the line break the input had there. A quote that never closes runs to the
 * end of the input.
 */
function rejoinQuotedRows(events: SplunkEvent[], quote: string | null, source: DelimitedSource): SplunkEvent[] {
  const lines = source.input === undefined ? null : { text: source.input, starts: lineStartsOf(source.input) };
  const rows: SplunkEvent[] = [];
  let row: PendingRow | null = null;
  let open = false;
  for (const event of events) {
    if (row === null) {
      row = { first: event, last: event, raw: event._raw };
    } else {
      row.raw += lineBreakBefore(lines, row.raw, event) + event._raw;
      row.last = event;
    }
    if (hasOddQuotes(event._raw, quote)) open = !open;
    if (!open) {
      rows.push(joinedRow(row, source.mode));
      row = null;
    }
  }
  if (row !== null) rows.push(joinedRow(row, source.mode));
  return rows;
}

/**
 * Whether `text` leaves a quote open. `parseDelimitedLine` opens or closes a
 * quote at each quote character, and reads a doubled one inside quotes as a
 * literal that leaves it open, so a quote is left open exactly when the count
 * is odd. With FIELD_QUOTE = none (`null`) nothing is quoted.
 */
function hasOddQuotes(text: string, quote: string | null): boolean {
  let odd = false;
  for (const ch of text) {
    if (ch === quote) odd = !odd;
  }
  return odd;
}

/** One event for a row, spanning the lines of every event it was put back together from. */
function joinedRow(row: PendingRow, mode: string): SplunkEvent {
  const { first, last } = row;
  if (last === first) return first;
  const lineNumbers = { start: first.lineNumbers.start, end: last.lineNumbers.end };
  return {
    ...first,
    _raw: row.raw,
    lineNumbers,
    processingTrace: [
      ...first.processingTrace,
      {
        processor: `INDEXED_EXTRACTIONS(${mode})`,
        phase: 'index-time' as const,
        description: `Lines ${lineNumbers.start}-${lineNumbers.end} are one row: a quoted value spans the line break`,
        fieldsAdded: [],
      },
    ],
  };
}

/** Where each line of `text` starts. */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

const isLineBreak = (ch: string) => ch === '\r' || ch === '\n';

/**
 * The line break the input had just before `event`, which continues the row
 * `row` holds so far: the run of `\r` and `\n` that ends where `event`'s line
 * starts, less what of it `row` already ends with (a LINE_BREAKER that leaves
 * the `\r` of a `\r\n` in the event). Without the input, or when `event` is
 * not where its line number puts it, the row is joined with `\n`, as line
 * merging joins lines.
 */
function lineBreakBefore(
  lines: { text: string; starts: readonly number[] } | null,
  row: string,
  event: SplunkEvent,
): string {
  if (lines === null) return '\n';
  const at = lines.starts[event.lineNumbers.start - 1];
  if (at === undefined || !lines.text.startsWith(event._raw, at)) return '\n';
  let start = at;
  while (isLineBreak(lines.text.charAt(start - 1))) start--;
  let kept = 0;
  while (isLineBreak(row.charAt(row.length - 1 - kept))) kept++;
  return lines.text.slice(start + kept, at);
}

function extractW3c(events: SplunkEvent[], directives: ConfDirective[], ctx: RunContext): SplunkEvent[] {
  // W3C format: header line starts with #Fields:
  let headers: string[] = [];

  for (const event of events) {
    const fieldsMatch = event._raw.match(/^#Fields:\s*(.+)$/m);
    if (fieldsMatch) {
      headers = (fieldsMatch[1] ?? '')
        .trim()
        .split(/\s+/)
        .map((name) => sanitizeHeaderName(name));
      break;
    }
  }

  if (headers.length === 0) return events;

  // Drop W3C directive/comment lines (#Version, #Fields, #Software, …) — they
  // are not indexed as events. A merged event carries its directive lines
  // inline, so test every line rather than only the first.
  const rows = events
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
  return applyTimestampFields(rows, directives, ctx);
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
 * and strips the leading underscores it reserves for internal fields, so a
 * W3C/IIS log's `cs-uri-stem` is indexed as `cs_uri_stem`.
 *
 * `acceptable` is HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS: characters that
 * survive cleaning. The spec's wording exempts a space by default too; this
 * still replaces it: nothing observed settles the point, and changing every
 * spaced header name on a doc reading alone risks a confident wrong answer.
 * Naming a space in the attribute keeps it.
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
function stripHeaderPrefix(raw: string, fieldHeaderRegex: SplunkRegex | null): string {
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

  const isDelimiter = (ch: string) => (opts.whitespaceDelimiter ? ch === ' ' || ch === '\t' : ch === opts.delimiter);

  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);

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
