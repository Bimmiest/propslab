import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { evaluateExpression } from '../processors/evalProcessor';
import { stripLeadingUnderscoreForField } from '../utils/internalFields';
import { deleteField, setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';

// Split "field=expr, field2=fn(a,b)" on top-level commas only — not inside parens
// and not inside a string literal (e.g. msg="a,b" must stay one assignment).
function splitAssignments(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      // Inside a string literal: only the matching quote (when not escaped) ends it.
      // Count the run of preceding backslashes — an odd count escapes the quote,
      // an even count (e.g. a value ending in `\\`) leaves it free to close.
      if (c === quote) {
        let bs = 0;
        for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) bs++;
        if (bs % 2 === 0) quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter(Boolean);
}

export function applyIngestEval(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
  /** What now()/time() return, in epoch ms. See `PipelineOptions.now`. */
  now: number = Date.now(),
): SplunkEvent[] {
  // A stanza may repeat INGEST_EVAL; Splunk's last-definition-wins rule means
  // only the final directive applies (each may still hold several comma-separated
  // assignments, all of which run).
  const lastIngestEval = directives.filter((d) => d.key === 'INGEST_EVAL').at(-1);
  if (lastIngestEval === undefined) return events;
  const ingestEvalDirs = [lastIngestEval];

  const reportedErrors = new Set<string>();
  const reportedStubs = new Set<string>();

  return events.map((event) => {
    const currentEvent = { ...event, fields: { ...event.fields } };
    let totalExpressions = 0;

    for (const ingestEvalDir of ingestEvalDirs) {
      const expressions = splitAssignments(ingestEvalDir.value);
      totalExpressions += expressions.length;

      for (const expr of expressions) {
        const eqIdx = expr.indexOf('=');
        if (eqIdx <= 0) continue;

        const fieldName = stripLeadingUnderscoreForField(expr.substring(0, eqIdx).trim());
        const evalExpr = expr.substring(eqIdx + 1).trim();

        try {
          const result = evaluateExpression(evalExpr, currentEvent, (fn) => {
            if (diagnostics && !reportedStubs.has(fn)) {
              reportedStubs.add(fn);
              diagnostics.push({
                level: 'warning',
                message: `${fn}() is not fully simulated — results may differ from real Splunk`,
                file: 'transforms.conf',
                ...atDirective(ingestEvalDir),
                directiveKey: ingestEvalDir.key,
              });
            }
          }, now);
          // INGEST_EVAL can rewrite the event's timestamp and raw text, not just
          // add indexed fields. Route _time/_raw to the event rather than fields.
          if (fieldName === '_time') {
            const epoch = result === null ? NaN : Number(Array.isArray(result) ? result[0] : result);
            if (!Number.isNaN(epoch)) currentEvent._time = new Date(epoch * 1000);
          } else if (fieldName === '_raw') {
            currentEvent._raw =
              result === null ? '' : Array.isArray(result) ? result.join('\n') : String(result);
          } else if (fieldName === 'queue') {
            // `INGEST_EVAL = queue=if(match(_raw,"DEBUG"), "nullQueue", "indexQueue")`
            // is Splunk's documented filtering idiom: assigning to `queue` routes
            // the event exactly as `DEST_KEY = queue` does. Writing it as an
            // ordinary field instead previewed dropped events as indexed — the
            // opposite of what the config does. Copy `_meta` rather than mutating
            // it: the shallow event copy still shares the input's object.
            const queue = result === null ? '' : String(Array.isArray(result) ? result[0] : result);
            currentEvent._meta = { ...currentEvent._meta, _queue: queue };
          } else if (result === null) {
            deleteField(currentEvent.fields, fieldName);
          } else if (Array.isArray(result)) {
            setField(currentEvent.fields, fieldName, result);
          } else {
            setField(currentEvent.fields, fieldName, String(result));
          }
        } catch (err) {
          if (diagnostics && !reportedErrors.has(fieldName)) {
            reportedErrors.add(fieldName);
            diagnostics.push({
              level: 'error',
              message: `INGEST_EVAL ${fieldName}: ${err instanceof Error ? err.message : String(err)}`,
              file: 'transforms.conf',
              ...atDirective(ingestEvalDir),
              directiveKey: ingestEvalDir.key,
            });
          }
        }
      }
    }

    return {
      ...currentEvent,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'INGEST_EVAL',
          phase: 'index-time' as const,
          description: `Evaluated ${totalExpressions} ingest-time expression(s)`,
        },
      ],
    };
  });
}
