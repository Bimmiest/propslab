import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { evaluateExpression, regexFailureMessage } from '../processors/evalProcessor';
import { stripLeadingUnderscoreForField } from '../utils/internalFields';
import { deleteField, setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';
import { effectiveDirective } from '../utils/directiveValues';
import { appendTraceStep, metadataChanges } from '../utils/traceStep';
import { BOOLEAN_ASSIGNMENT_ERROR, numArg } from '../processors/eval/values';
import { dateFromEpochSeconds, epochOutOfRangeMessage } from '../utils/epochTime';

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

/**
 * The event metadata an INGEST_EVAL assignment rewrites instead of adding an
 * indexed field. transforms.conf.spec lists these with _raw, _time and queue
 * as the keys INGEST_EVAL writes into the event itself.
 */
const METADATA_KEYS = new Set<string>(['index', 'host', 'source', 'sourcetype']);

/** The DEST_KEY that rewrites the same metadata, as the trace names it. */
const METADATA_DEST_KEYS = {
  index: 'MetaData:Index',
  host: 'MetaData:Host',
  source: 'MetaData:Source',
  sourcetype: 'MetaData:Sourcetype',
} as const;

function isMetadataKey(name: string): name is 'index' | 'host' | 'source' | 'sourcetype' {
  return METADATA_KEYS.has(name);
}

/**
 * Split one `field=expr` or `field:=expr` assignment at its operator.
 *
 * `:=` is INGEST_EVAL's replace-assignment operator (transforms.conf.spec), so
 * the `:` belongs to the operator, not the field name. Both operators are
 * handled identically after this point: the simulator already replaces an
 * existing field's value on `=`, which is exactly what the spec says `:=` does.
 * The spec's multivalue-append reading of `=` on an existing field is not
 * modelled — see the note in ingestEval.test.ts.
 */
function splitAssignment(expr: string): { fieldName: string; evalExpr: string } | null {
  const eqIdx = expr.indexOf('=');
  if (eqIdx <= 0) return null;
  const nameEnd = expr.charAt(eqIdx - 1) === ':' ? eqIdx - 1 : eqIdx;
  const rawName = expr.substring(0, nameEnd).trim();
  if (rawName === '') return null;
  return {
    fieldName: stripLeadingUnderscoreForField(rawName),
    evalExpr: expr.substring(eqIdx + 1).trim(),
  };
}

/**
 * What INGEST_EVAL has already reported. The transforms pass calls
 * applyIngestEval once per event, so it owns one of these for the whole run
 * and passes it in; sets local to the call would forget between events.
 */
export interface IngestEvalReported {
  /** Fields whose assignment threw. */
  errors: Set<string>;
  /** Builtins that are not fully simulated. */
  stubs: Set<string>;
  /**
   * Warnings, by message: stubs, regex failures and out-of-range `_time`.
   * STOP_PROCESSING_IF reports into the same set, since its stub warning reads
   * the same as this one.
   */
  messages: Set<string>;
}

export function newIngestEvalReported(): IngestEvalReported {
  return { errors: new Set(), stubs: new Set(), messages: new Set() };
}

/**
 * `_time=<epoch>`. A number no Date can hold keeps the event's previous
 * `_time`, with a warning.
 */
function assignTime(
  event: SplunkEvent,
  epoch: number | null,
  dir: ConfDirective,
  diagnostics: ValidationDiagnostic[] | undefined,
  reported: IngestEvalReported,
): void {
  if (epoch === null) return;
  const time = dateFromEpochSeconds(epoch);
  if (time) {
    event._time = time;
    return;
  }
  const message = epochOutOfRangeMessage('INGEST_EVAL _time', epoch);
  if (diagnostics && !reported.messages.has(message)) {
    reported.messages.add(message);
    diagnostics.push({
      level: 'warning',
      message,
      file: 'transforms.conf',
      ...atDirective(dir),
      directiveKey: dir.key,
    });
  }
}

/** A builtin that is not fully simulated, once per function per run. */
function reportStub(
  fn: string,
  dir: ConfDirective,
  diagnostics: ValidationDiagnostic[] | undefined,
  reported: IngestEvalReported,
): void {
  if (!diagnostics || reported.stubs.has(fn)) return;
  reported.stubs.add(fn);
  const message = `${fn}() is not fully simulated — results may differ from real Splunk`;
  reported.messages.add(message);
  diagnostics.push({
    level: 'warning',
    message,
    file: 'transforms.conf',
    ...atDirective(dir),
    directiveKey: dir.key,
  });
}

export function applyIngestEval(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
  /** What now()/time() return, in epoch ms. See `PipelineOptions.now`. */
  now: number = Date.now(),
  /** What this run has already reported; see IngestEvalReported. */
  reported: IngestEvalReported = newIngestEvalReported(),
): SplunkEvent[] {
  // A stanza may repeat INGEST_EVAL; Splunk's last-definition-wins rule means
  // only the final directive applies (each may still hold several comma-separated
  // assignments, all of which run).
  const lastIngestEval = effectiveDirective(directives, 'INGEST_EVAL');
  if (lastIngestEval === undefined) return events;
  const ingestEvalDirs = [lastIngestEval];

  const { errors: reportedErrors } = reported;

  return events.map((event) => {
    const currentEvent = { ...event, fields: { ...event.fields } };
    let totalExpressions = 0;

    for (const ingestEvalDir of ingestEvalDirs) {
      const expressions = splitAssignments(ingestEvalDir.value);
      totalExpressions += expressions.length;

      for (const expr of expressions) {
        const assignment = splitAssignment(expr);
        if (!assignment) continue;
        const { fieldName, evalExpr } = assignment;

        try {
          const result = evaluateExpression(evalExpr, currentEvent, (fn) => {
            reportStub(fn, ingestEvalDir, diagnostics, reported);
          }, now, (fn, pattern) => {
            const message = `INGEST_EVAL ${fieldName}: ${regexFailureMessage(fn, pattern)}`;
            if (diagnostics && !reported.messages.has(message)) {
              reported.messages.add(message);
              diagnostics.push({
                level: 'warning',
                message,
                file: 'transforms.conf',
                ...atDirective(ingestEvalDir),
                directiveKey: ingestEvalDir.key,
              });
            }
          });
          // Refused as in EVAL-: the assignment writes nothing, not "true".
          if (typeof result === 'boolean') throw new Error(BOOLEAN_ASSIGNMENT_ERROR);
          // INGEST_EVAL can rewrite the event's timestamp and raw text, not just
          // add indexed fields. Route _time/_raw to the event rather than fields.
          if (fieldName === '_time') {
            assignTime(currentEvent, numArg(result), ingestEvalDir, diagnostics, reported);
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
          } else if (isMetadataKey(fieldName)) {
            // index/host/source/sourcetype are the event's metadata, not indexed
            // fields: assigning one rewrites it exactly as DEST_KEY =
            // MetaData:<Key> does, so the event lands in the new index and — in
            // per-event mode — is re-matched against the new sourcetype's
            // stanzas. Written into `fields` instead, the routing would be
            // untouched while the preview showed a field claiming otherwise.
            // The value is bare: unlike FORMAT for DEST_KEY there is
            // no `host::` prefix to strip. A null result has nothing to route
            // to, and the event keeps the metadata it has, as it does when a
            // DEST_KEY FORMAT lacks its prefix.
            if (result !== null) {
              const value = String(Array.isArray(result) ? result[0] ?? '' : result);
              currentEvent.metadata = { ...currentEvent.metadata, [fieldName]: value };
            }
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

    // The step says what it rewrote: `_raw` through the same mutation record
    // DEST_KEY = _raw leaves, so field attribution reaches it, and metadata as
    // old → new. The description
    // names each key as its DEST_KEY, as a DEST_KEY = MetaData:* step does.
    const changes = metadataChanges(event.metadata, currentEvent.metadata);
    const description =
      `Evaluated ${totalExpressions} ingest-time expression(s)` +
      (changes.length > 0
        ? `; set ${changes.map((c) => `${METADATA_DEST_KEYS[c.key]} "${c.from}" → "${c.to}"`).join(', ')}`
        : '');
    return appendTraceStep(
      currentEvent,
      {
        processor: 'INGEST_EVAL',
        phase: 'index-time' as const,
        description,
        ...(changes.length > 0 ? { metadataChanges: changes } : {}),
      },
      event._raw,
    );
  });
}
