import type { SplunkEvent, ConfDirective, DirectiveNoOp } from '../types';
import { fieldQuotingWarning } from '../utils/fieldRef';
import { deleteField, setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';
import { BOOLEAN_ASSIGNMENT_ERROR, type EvalValue } from './eval/values';
import { type Node, parseExpression } from './eval/parser';
import { evalNode } from './eval/evaluator';
import { regexFailureMessage } from './eval/builtins';
import type { RunContext, DiagnosticSink } from '../runContext';

// EVAL- as a props processor: which directives run, how their results land on
// the event, and the diagnostics they raise. The expression language itself is
// under ./eval/ (tokenizer, parser, evaluator, builtins, value coercions); the
// two exports below are re-exported so INGEST_EVAL and STOP_PROCESSING_IF keep
// importing them from here.
export { evaluateExpression } from './eval/evaluator';
export { regexFailureMessage };

/**
 * Hint for the common mistake of referencing a nested JSON field unquoted: the
 * `.` is the concat operator, so `event.field` won't read the field named
 * `event.field`. Only warn when the bare dotted name (outside quotes) actually
 * matches an extracted field — high precision, no false positives on real concat.
 */
function warnDottedFieldRefs(
  events: SplunkEvent[],
  evalDirectives: ConfDirective[],
  diagnostics: DiagnosticSink,
): void {
  const reportedDotted = new Set<string>();
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

/**
 * The diagnostics an EVAL raises while it runs, each reported once per
 * directive (or per pattern) rather than once per event.
 */
class EvalReporter {
  private readonly reportedErrors = new Set<string>();
  private readonly reportedStubs = new Set<string>();
  private readonly reportedRegex = new Set<string>();
  private readonly diagnostics: DiagnosticSink | undefined;

  constructor(diagnostics: DiagnosticSink | undefined) {
    this.diagnostics = diagnostics;
  }

  stub(dir: ConfDirective, fn: string): void {
    if (!this.diagnostics || this.reportedStubs.has(fn)) return;
    this.reportedStubs.add(fn);
    this.diagnostics.push({
      level: 'warning',
      message: `${fn}() is not fully simulated — results may differ from real Splunk`,
      file: 'props.conf',
      ...atDirective(dir),
      directiveKey: dir.key,
    });
  }

  /**
   * Once per class and pattern: a pattern that will not compile fails the same
   * way on every event, and a field built from event data can still yield a
   * different pattern per event without flooding the list with one per line.
   */
  regex(dir: ConfDirective, fieldName: string, fn: string, pattern: string): void {
    const key = `${fieldName}\u0000${pattern}`;
    if (!this.diagnostics || this.reportedRegex.has(key)) return;
    this.reportedRegex.add(key);
    this.diagnostics.push({
      level: 'warning',
      message: `EVAL-${fieldName}: ${regexFailureMessage(fn, pattern)}`,
      file: 'props.conf',
      ...atDirective(dir),
      directiveKey: dir.key,
    });
  }

  error(dir: ConfDirective, fieldName: string, msg: string): void {
    if (!this.diagnostics || this.reportedErrors.has(fieldName)) return;
    this.reportedErrors.add(fieldName);
    this.diagnostics.push({
      level: 'error',
      message: `EVAL-${fieldName}: ${msg}`,
      file: 'props.conf',
      ...atDirective(dir),
      directiveKey: dir.key,
    });
  }
}

/** An EVAL directive, parsed once: its AST, or the parse error. */
type CompiledEval =
  | { dir: ConfDirective; fieldName: string; ast: Node; error: null }
  | { dir: ConfDirective; fieldName: string; ast: null; error: string };

/**
 * Parse each directive's expression once into an AST; per-event evaluation
 * reuses it rather than re-tokenising every event. The AST also enables lazy
 * evaluation of branching functions.
 */
function compileEvals(evalDirectives: ConfDirective[]): CompiledEval[] {
  return evalDirectives
    .filter((dir) => (dir.className ?? '') !== '')
    .map((dir) => {
      const fieldName = dir.className ?? '';
      try {
        return { dir, fieldName, ast: parseExpression(dir.value.trim()), error: null };
      } catch (err) {
        return { dir, fieldName, ast: null, error: err instanceof Error ? err.message : String(err) };
      }
    });
}

type EvalResults = Map<string, { value: EvalValue; expression: string }>;

/** Eval expressions run in parallel — compute all before applying. */
function evaluateAll(event: SplunkEvent, compiled: CompiledEval[], reporter: EvalReporter, now: number): EvalResults {
  const results: EvalResults = new Map();
  for (const c of compiled) {
    if (c.error !== null) {
      reporter.error(c.dir, c.fieldName, c.error);
      continue;
    }
    try {
      const value = evalNode(c.ast, {
        event,
        now,
        onStubWarning: (fn) => reporter.stub(c.dir, fn),
        onRegexError: (fn, pattern) => reporter.regex(c.dir, c.fieldName, fn, pattern),
      });
      // Splunk refuses the assignment outright; writing "true" would show a
      // field the real search never produces.
      if (typeof value === 'boolean') throw new Error(BOOLEAN_ASSIGNMENT_ERROR);
      results.set(c.fieldName, { value, expression: c.dir.value.trim() });
    } catch (err) {
      reporter.error(c.dir, c.fieldName, err instanceof Error ? err.message : String(err));
    }
  }
  return results;
}

/** Write an event's EVAL results onto it, tracing the computed fields. */
function applyResults(event: SplunkEvent, results: EvalResults, byField: Map<string, ConfDirective>): SplunkEvent {
  const noOps: DirectiveNoOp[] = [];
  const newFields = { ...event.fields };
  const added: string[] = [];
  // The expression behind each computed field, so the UI never has to
  // re-parse props.conf to recover it. These are the directives that survived
  // stanza matching for this event, which a text scan cannot know.
  const evalExpressions: Record<string, string> = {};

  for (const [field, { value, expression }] of results) {
    if (value === null) {
      // A null result deletes the field, so an EVAL that was meant to create
      // one leaves no trace of having run at all. Null propagation makes
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
}

export function applyEvalExpressions(
  events: SplunkEvent[],
  directives: ConfDirective[],
  /** `ctx.now` is what now()/time() return. */
  ctx: RunContext,
): SplunkEvent[] {
  const { diagnostics, now } = ctx;
  const evalDirectives = directives.filter((d) => d.directiveType === 'EVAL');
  if (evalDirectives.length === 0) return events;

  if (diagnostics) warnDottedFieldRefs(events, evalDirectives, diagnostics);
  const reporter = new EvalReporter(diagnostics);
  const compiled = compileEvals(evalDirectives);
  /** Field name → the directive that computes it, for locating a no-op. */
  const byField = new Map(compiled.map((c) => [c.fieldName, c.dir]));

  return events.map((event) => {
    const results = evaluateAll(event, compiled, reporter, now);
    return results.size === 0 ? event : applyResults(event, results, byField);
  });
}
