import type { Confidence, ScaffoldSuggestion } from '../types';
import { escapeRegex } from '../../../utils/splunkRegex';

/**
 * Detect the line/event format and propose the matching props.conf directives
 * (KV_MODE / INDEXED_EXTRACTIONS / LINE_BREAKER / SHOULD_LINEMERGE).
 *
 * Precedent — INDEXED_EXTRACTIONS vs KV_MODE (Splunk guidance: prefer search-time
 * extraction unless index-time is specifically needed):
 *   • Delimited files (CSV / TSV / PSV / W3C) → INDEXED_EXTRACTIONS. They require
 *     index-time structured parsing; there is no search-time KV_MODE equivalent.
 *   • JSON / XML / key=value → KV_MODE (search-time). Flexible, no index bloat, no
 *     extra storage/license cost. We deliberately do NOT propose
 *     INDEXED_EXTRACTIONS=json — and never both (that double-extracts and
 *     duplicates field values). Index-time JSON is a niche choice (e.g. tstats /
 *     accelerated data models) left to the engineer.
 */
export function detectLineFormat(rawData: string, lines: string[]): ScaffoldSuggestion[] {
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return [];

  // XML — declaration or a leading element.
  if (/<\?xml/i.test(rawData) || /^\s*<[a-zA-Z!]/.test(rawData)) {
    const kvMode: ScaffoldSuggestion = { key: 'KV_MODE', value: 'xml', confidence: 'high', evidence: 'Input looks like XML', enabledByDefault: true };
    // Without an explicit breaker the default line merge (BREAK_ONLY_BEFORE_DATE)
    // splits a multi-line document at any line holding a date.
    const breaker = xmlDocumentBreaker(rawData);
    if (!breaker) return [kvMode];
    return [
      { key: 'LINE_BREAKER', value: breaker.regex, confidence: 'medium', evidence: breaker.evidence, enabledByDefault: true },
      { key: 'SHOULD_LINEMERGE', value: 'false', confidence: 'medium', evidence: 'Events are delimited by the LINE_BREAKER, not merged', enabledByDefault: true },
      kvMode,
    ];
  }

  // JSON, one object per line.
  const jsonLines = nonBlank.filter(isJsonLine).length;
  const jsonRatio = jsonLines / nonBlank.length;
  if (jsonRatio >= 0.8) {
    return [
      { key: 'LINE_BREAKER', value: '([\\r\\n]+)', confidence: 'medium', evidence: 'One JSON object per line — break on newlines', enabledByDefault: true },
      { key: 'SHOULD_LINEMERGE', value: 'false', confidence: 'high', evidence: 'JSON events are a single line each; do not merge', enabledByDefault: true },
      { key: 'KV_MODE', value: 'json', confidence: jsonRatio === 1 ? 'high' : 'medium', evidence: `${jsonLines}/${nonBlank.length} lines parse as JSON — search-time KV_MODE preferred over INDEXED_EXTRACTIONS (no index bloat)`, enabledByDefault: true },
    ];
  }

  // Multi-line JSON objects, one or several (`}` … `{` across lines). Each object
  // spans several lines, so the per-line JSON check above misses them. Even a
  // single object needs the breaker: under the default line merge
  // (BREAK_ONLY_BEFORE_DATE) it would split at any line holding a date.
  const trimmed = rawData.trim();
  const several = /\}\s*[\r\n]+\s*\{/.test(rawData);
  if (trimmed.startsWith('{') && (several || (nonBlank.length > 1 && tryParse(trimmed)))) {
    return [
      {
        key: 'LINE_BREAKER',
        value: '([\\r\\n]+)(?=\\{)',
        confidence: 'medium',
        evidence: several
          ? 'Multiple newline-separated JSON objects — break before each one'
          : 'Multi-line JSON object — break only before a top-level `{`, so the object stays whole',
        enabledByDefault: true,
      },
      { key: 'SHOULD_LINEMERGE', value: 'false', confidence: 'medium', evidence: 'Events are delimited by the LINE_BREAKER, not merged', enabledByDefault: true },
      { key: 'KV_MODE', value: 'json', confidence: 'medium', evidence: 'JSON payload', enabledByDefault: true },
    ];
  }

  // Delimited (CSV / TSV / PSV).
  const delim = detectDelimiter(nonBlank);
  if (delim) {
    return [{ key: 'INDEXED_EXTRACTIONS', value: delim.format, confidence: delim.confidence, evidence: `${delim.evidence} — delimited files use index-time structured extraction`, enabledByDefault: true }];
  }

  // Whitespace-indented continuation lines → merge into the preceding event.
  const continuation = nonBlank.filter((l) => /^\s/.test(l)).length;
  if (continuation > 0 && continuation / nonBlank.length >= 0.1) {
    return [
      { key: 'SHOULD_LINEMERGE', value: 'true', confidence: 'medium', evidence: `${continuation} line(s) start with whitespace (continuations)`, enabledByDefault: true },
      { key: 'BREAK_ONLY_BEFORE', value: '^\\S', confidence: 'medium', evidence: 'Start a new event only on a non-indented line', enabledByDefault: true },
    ];
  }

  return [];
}

/**
 * A LINE_BREAKER that breaks only before each top-level XML document, or null
 * when the sample's top level cannot be read. When every document opens with an
 * XML declaration the break is before it, so the declaration stays with its
 * root; otherwise it is before the root element names seen at depth 0. Like the
 * JSON breaker, it assumes each document starts at column 0.
 */
function xmlDocumentBreaker(rawData: string): { regex: string; evidence: string } | null {
  const roots = new Set<string>();
  let rootCount = 0;
  let depth = 0;
  // `[^'"<>]` rather than `[^'">]` so an unclosed tag stops at the next `<`
  // instead of rescanning the rest of the sample.
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][^>]*>|<(\/?)([A-Za-z_][\w.:-]*)(?:"[^"]*"|'[^']*'|[^'"<>])*?(\/?)>/g;
  for (const m of rawData.matchAll(tagRe)) {
    const name = m[2];
    if (name === undefined) continue;
    if (m[1]) {
      if (--depth < 0) return null;
      continue;
    }
    if (depth === 0) {
      roots.add(name);
      rootCount++;
    }
    if (!m[3]) depth++;
  }
  if (rootCount === 0) return null;

  const declarations = rawData.match(/(?:^|[\r\n])\s*<\?xml\s/gi)?.length ?? 0;
  if (declarations === rootCount) {
    return { regex: '([\\r\\n]+)(?=<\\?xml\\s)', evidence: 'Each XML document opens with a declaration — break only before each one' };
  }
  // Some documents carry a declaration and some do not: breaking before the
  // root would strand a declaration as an event of its own.
  if (declarations > 0) return null;

  const names = [...roots].map(escapeRegex).join('|');
  const alternation = roots.size === 1 ? names : `(?:${names})`;
  return {
    regex: `([\\r\\n]+)(?=<${alternation}[\\s/>])`,
    evidence: `Top-level XML element${roots.size === 1 ? '' : 's'} ${[...roots].map((n) => `<${n}>`).join(', ')} — break only before each one`,
  };
}

function isJsonLine(line: string): boolean {
  const t = line.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  return tryParse(t);
}

function tryParse(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null;
  } catch {
    return false;
  }
}

function countChar(line: string, ch: string): number {
  let n = 0;
  for (const c of line) if (c === ch) n++;
  return n;
}

function detectDelimiter(lines: string[]): { format: string; confidence: Confidence; evidence: string } | null {
  // Delimited detection needs a header plus at least one data row; a single
  // comma-containing line (e.g. prose) must not be mistaken for CSV.
  if (lines.length < 2) return null;
  const candidates: Array<[string, string]> = [[',', 'csv'], ['\t', 'tsv'], ['|', 'psv']];
  const sample = lines.slice(0, 50);
  let best: { format: string; confidence: Confidence; evidence: string; score: number } | null = null;

  for (const [ch, format] of candidates) {
    const counts = sample.map((l) => countChar(l, ch));
    const headerCount = counts[0] ?? 0;
    if (headerCount < 1) continue;
    const consistent = counts.filter((c) => c === headerCount).length;
    const ratio = consistent / counts.length;
    if (ratio < 0.7) continue;
    const score = ratio * headerCount;
    if (!best || score > best.score) {
      best = {
        format,
        confidence: ratio >= 0.95 ? 'high' : 'medium',
        evidence: `Consistent ${headerCount + 1} ${format.toUpperCase()} columns across ${consistent}/${counts.length} lines`,
        score,
      };
    }
  }
  return best ? { format: best.format, confidence: best.confidence, evidence: best.evidence } : null;
}
