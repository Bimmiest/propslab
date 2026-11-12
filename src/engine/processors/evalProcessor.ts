import type { SplunkEvent, ConfDirective, DirectiveNoOp } from '../types';
import { fieldQuotingWarning } from '../utils/fieldRef';
import { deleteField, hasField, setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';
import { BOOLEAN_ASSIGNMENT_ERROR, type EvalValue } from './eval/values';
import { type Node, parseExpression } from './eval/parser';
import { evalNode } from './eval/evaluator';
import { regexFailureMessage, regexLimitMessage } from './eval/builtins';
import type { RunContext, DiagnosticSink } from '../runContext';
import { RegexDeadlineError } from '../../utils/splunkRegex';

// EVAL- as a props processor: which directives run, how their results land on
// the event, and the diagnostics they raise. The expression language itself is
// under ./eval/ (tokenizer, parser, evaluator, builtins, value coercions); the
// two exports below are re-exported so INGEST_EVAL and STOP_PROCESSING_IF keep
// importing them from here.
export { evaluateExpression } from './eval/evaluator';
export { regexFailureMessage, regexLimitMessage };

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

  /**
   * Once per class and message, so once per pattern and limit: a scan that
   * stops at a limit on one event may stop on many.
   */
  regexLimit(dir: ConfDirective, fieldName: string, detail: string): void {
    const message = `EVAL-${fieldName}: ${detail}`;
    if (!this.diagnostics || this.reportedRegex.has(message)) return;
    this.reportedRegex.add(message);
    this.diagnostics.push({
      level: 'warning',
      message,
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
        onRegexLimit: (fn, pattern, error) =>
          reporter.regexLimit(c.dir, c.fieldName, regexLimitMessage(fn, pattern, error)),
      });
      // Splunk refuses the assignment outright; writing "true" would show a
      // field the real search never produces.
      if (typeof value === 'boolean') throw new Error(BOOLEAN_ASSIGNMENT_ERROR);
      results.set(c.fieldName, { value, expression: c.dir.value.trim() });
    } catch (err) {
      if (err instanceof RegexDeadlineError) throw err;
      reporter.error(c.dir, c.fieldName, err instanceof Error ? err.message : String(err));
    }
  }
  return results;
}

/**
 * Write an event's EVAL results onto it, and trace what they changed. A field
 * that the event had before is modified, not added (#900). A null result
 * removes a field that the event had, and is a no-op otherwise: a no-op is not
 * in the trace (ADR 0010, #876).
 */
function applyResults(event: SplunkEvent, results: EvalResults, byField: Map<string, ConfDirective>): SplunkEvent {
  const noOps: DirectiveNoOp[] = [];
  const newFields = { ...event.fields };
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  // The expression behind each computed field, so the UI never has to
  // re-parse props.conf to recover it. These are the directives that survived
  // stanza matching for this event, which a text scan cannot know.
  const evalExpressions: Record<string, string> = {};

  for (const [field, { value, expression }] of results) {
    const existed = hasField(event.fields, field);
    if (value === null) {
      if (existed) {
        deleteField(newFields, field);
        removed.push(field);
        evalExpressions[field] = expression;
        continue;
      }
      // Null propagation makes this the most common way that an EVAL does
      // nothing, and nothing in the preview would say so.
      noOps.push({
        directive: `EVAL-${field}`,
        file: 'props.conf',
        line: byField.get(field)?.line ?? 0,
        phase: 'search-time',
        reason: { kind: 'eval-null', expression },
      });
      continue;
    }
    setField(newFields, field, Array.isArray(value) ? value : String(value));
    (existed ? modified : added).push(field);
    evalExpressions[field] = expression;
  }

  const withNoOps = noOps.length > 0 ? { noOps: [...(event.noOps ?? []), ...noOps] } : {};
  if (added.length + modified.length + removed.length === 0) return { ...event, ...withNoOps };

  const description = [
    ...(added.length > 0 ? [`Computed fields: ${added.join(', ')}`] : []),
    ...(modified.length > 0 ? [`Changed fields: ${modified.join(', ')}`] : []),
    ...(removed.length > 0 ? [`Removed fields (null): ${removed.join(', ')}`] : []),
  ];
  return {
    ...event,
    ...withNoOps,
    fields: newFields,
    processingTrace: [
      ...event.processingTrace,
      {
        processor: 'EVAL',
        phase: 'search-time' as const,
        description: description.join('; '),
        fieldsAdded: added,
        ...(modified.length > 0 ? { fieldsModified: modified } : {}),
        ...(removed.length > 0 ? { fieldsRemoved: removed } : {}),
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

  warnDottedFieldRefs(events, evalDirectives, diagnostics);
  const reporter = new EvalReporter(diagnostics);
  const compiled = compileEvals(evalDirectives);
  /** Field name → the directive that computes it, for locating a no-op. */
  const byField = new Map(compiled.map((c) => [c.fieldName, c.dir]));

  return events.map((event) => {
    const results = evaluateAll(event, compiled, reporter, now);
    return results.size === 0 ? event : applyResults(event, results, byField);
  });
}
