import type { SplunkEvent, ConfDirective, DirectiveNoOp, ValidationDiagnostic } from '../types';
import { fieldQuotingWarning } from '../utils/fieldRef';
import { deleteField, setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';
import type { EvalValue } from './eval/values';
import { parseExpression } from './eval/parser';
import { evalNode } from './eval/evaluator';
import { regexFailureMessage } from './eval/builtins';

// EVAL- as a props processor: which directives run, how their results land on
// the event, and the diagnostics they raise. The expression language itself is
// under ./eval/ (tokenizer, parser, evaluator, builtins, value coercions); the
// two exports below are re-exported so INGEST_EVAL and STOP_PROCESSING_IF keep
// importing them from here.
export { evaluateExpression } from './eval/evaluator';
export { regexFailureMessage };

export function applyEvalExpressions(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
  /** What now()/time() return, in epoch ms. See `PipelineOptions.now`. */
  now: number = Date.now(),
): SplunkEvent[] {
  const evalDirectives = directives.filter((d) => d.directiveType === 'EVAL');

  if (evalDirectives.length === 0) return events;

  // Collect per-directive errors/warnings once to avoid O(events) duplicates.
  const reportedErrors = new Set<string>();
  const reportedStubs = new Set<string>();
  const reportedDotted = new Set<string>();
  const reportedRegex = new Set<string>();

  // Hint for the common mistake of referencing a nested JSON field unquoted: the
  // `.` is the concat operator, so `event.field` won't read the field named
  // `event.field`. Only warn when the bare dotted name (outside quotes) actually
  // matches an extracted field — high precision, no false positives on real concat.
  if (diagnostics) {
    const allFieldNames = new Set<string>();
    for (const ev of events) {
      for (const k of Object.keys(ev.fields)) allFieldNames.add(k);
    }
    for (const dir of evalDirectives) {
      const fieldName = dir.className ?? '';
      if (!fieldName) continue;
      const outsideQuotes = dir.value.replace(/'[^']*'|"[^"]*"/g, '');
      const dottedRefs = outsideQuotes.match(/[A-Za-z_]\w*(?:\.\w+)+/g) ?? [];
      const hit = dottedRefs.find((r) => allFieldNames.has(r));
      if (hit && !reportedDotted.has(`${fieldName}|${hit}`)) {
        reportedDotted.add(`${fieldName}|${hit}`);
        diagnostics.push(
          fieldQuotingWarning(dir, hit, 'is read as concatenation (. is the concat operator), not a field reference'),
        );
      }
    }
  }

  const pushStub = (dir: ConfDirective, fn: string) => {
    if (diagnostics && !reportedStubs.has(fn)) {
      reportedStubs.add(fn);
      diagnostics.push({
        level: 'warning',
        message: `${fn}() is not fully simulated — results may differ from real Splunk`,
        file: 'props.conf',
        ...atDirective(dir),
        directiveKey: dir.key,
      });
    }
  };
  // Once per class and pattern: a pattern that will not compile fails the same
  // way on every event, and a field built from event data can still yield a
  // different pattern per event without flooding the list with one per line.
  const pushRegex = (dir: ConfDirective, fieldName: string, fn: string, pattern: string) => {
    const key = `${fieldName}\u0000${pattern}`;
    if (diagnostics && !reportedRegex.has(key)) {
      reportedRegex.add(key);
      diagnostics.push({
        level: 'warning',
        message: `EVAL-${fieldName}: ${regexFailureMessage(fn, pattern)}`,
        file: 'props.conf',
        ...atDirective(dir),
        directiveKey: dir.key,
      });
    }
  };
  const pushError = (dir: ConfDirective, fieldName: string, msg: string) => {
    if (diagnostics && !reportedErrors.has(fieldName)) {
      reportedErrors.add(fieldName);
      diagnostics.push({
        level: 'error',
        message: `EVAL-${fieldName}: ${msg}`,
        file: 'props.conf',
        ...atDirective(dir),
        directiveKey: dir.key,
      });
    }
  };

  // Parse each directive's expression once into an AST; per-event evaluation
  // reuses it (SEM-8: parse-once-per-directive instead of re-tokenising every
  // event). The AST also enables lazy evaluation of branching functions.
  const compiled = evalDirectives
    .filter((dir) => (dir.className ?? '') !== '')
    .map((dir) => {
      const fieldName = dir.className as string;
      try {
        return { dir, fieldName, ast: parseExpression(dir.value.trim()), error: null as string | null };
      } catch (err) {
        return { dir, fieldName, ast: null, error: err instanceof Error ? err.message : String(err) };
      }
    });

  /** Field name → the directive that computes it, for locating a no-op (#84). */
  const byField = new Map(compiled.map((c) => [c.fieldName, c.dir]));

  return events.map((event) => {
    // Eval expressions run in parallel — compute all before applying
    const results = new Map<string, { value: EvalValue; expression: string }>();
    const noOps: DirectiveNoOp[] = [];

    for (const c of compiled) {
      if (c.error !== null) {
        pushError(c.dir, c.fieldName, c.error);
        continue;
      }
      try {
        const value = evalNode(c.ast!, {
          event,
          now,
          onStubWarning: (fn) => pushStub(c.dir, fn),
          onRegexError: (fn, pattern) => pushRegex(c.dir, c.fieldName, fn, pattern),
        });
        results.set(c.fieldName, { value, expression: c.dir.value.trim() });
      } catch (err) {
        pushError(c.dir, c.fieldName, err instanceof Error ? err.message : String(err));
      }
    }

    if (results.size === 0) return event;

    const newFields = { ...event.fields };
    const added: string[] = [];
    // The expression behind each computed field, so the UI never has to
    // re-parse props.conf to recover it. These are the directives that survived
    // stanza matching for this event, which a text scan cannot know.
    const evalExpressions: Record<string, string> = {};

    for (const [field, { value, expression }] of results) {
      if (value === null) {
        // A null result deletes the field, so an EVAL that was meant to create
        // one leaves no trace of having run at all (#84). Null propagation makes
        // this the single most common way an EVAL silently does nothing.
        noOps.push({
          directive: `EVAL-${field}`,
          file: 'props.conf',
          line: byField.get(field)?.line ?? 0,
          phase: 'search-time',
          reason: { kind: 'eval-null', expression },
        });
        deleteField(newFields, field);
      } else if (Array.isArray(value)) {
        setField(newFields, field, value);
      } else {
        setField(newFields, field, String(value));
      }
      added.push(field);
      evalExpressions[field] = expression;
    }

    return {
      ...event,
      fields: newFields,
      ...(noOps.length > 0 ? { noOps: [...(event.noOps ?? []), ...noOps] } : {}),
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'EVAL',
          phase: 'search-time' as const,
          description: `Computed fields: ${added.join(', ')}`,
          fieldsAdded: added,
          evalExpressions,
        },
      ],
    };
  });
}
