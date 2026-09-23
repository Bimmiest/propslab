import type { SplunkEvent, ConfDirective, DirectiveNoOp, ValidationDiagnostic } from '../types';
import { safeRegex } from '../../utils/splunkRegex';
import { formatStrftime } from '../../utils/strftime';
import { fieldQuotingWarning } from '../utils/fieldRef';
import { getMetadataField } from '../utils/metadataFields';
import { deleteField, getField as getOwnField, setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';

type EvalValue = string | number | boolean | null | string[];

/**
 * An argument slot that may not have been supplied. Splunk treats a missing eval
 * argument as NULL, which is exactly what every coercion helper below already
 * does with `undefined` — so builtins can index `args[n]` freely and let the
 * coercion decide, instead of asserting the argument was passed.
 */
type EvalArg = EvalValue | undefined;

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
        const value = evalNode(c.ast!, { event, now, onStubWarning: (fn) => pushStub(c.dir, fn) });
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

// ── Tokenizer ───────────────────────────────────────────

type TokenType = 'string' | 'number' | 'ident' | 'field_ref' | 'op' | 'paren' | 'comma' | 'dot';

interface Token {
  type: TokenType;
  value: string;
}

/**
 * Lex an eval expression.
 *
 * Character access goes through `charAt` rather than `expr[i]`: every read here
 * is already inside an `i < expr.length` loop, and charAt returns a plain string
 * for an in-bounds index instead of `string | undefined`. The two lookaheads at
 * `i + 1` are the only reads that can run off the end, and both compare the
 * result against a literal — where charAt's `''` is the answer we want anyway.
 */
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr.charAt(i))) { i++; continue; }

    // Double-quoted string literals. Splunk eval gives only `\"` and `\\` a
    // special meaning inside a literal and passes every other escape through
    // intact — string literals are the way regexes reach match()/replace()/rex(),
    // so collapsing `\d` to `d` would silently rewrite the user's pattern. (The
    // official replace() docs example is `"^(\d{1,2})/(\d{1,2})/"`, with single
    // backslashes.)
    if (expr.charAt(i) === '"') {
      let str = '';
      i++;
      while (i < expr.length && expr.charAt(i) !== '"') {
        if (expr.charAt(i) === '\\' && i + 1 < expr.length && (expr.charAt(i + 1) === '"' || expr.charAt(i + 1) === '\\')) {
          str += expr.charAt(i + 1);
          i += 2;
        } else {
          str += expr.charAt(i);
          i++;
        }
      }
      i++; // skip closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    // Single-quoted field references (Splunk uses '' for field names with special chars)
    if (expr.charAt(i) === "'") {
      let name = '';
      i++;
      while (i < expr.length && expr.charAt(i) !== "'") {
        name += expr.charAt(i);
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: 'field_ref', value: name });
      continue;
    }

    // Numbers. A leading `-` is folded into a numeric literal only when a value
    // cannot already be in progress — at the start, after an operator or comma,
    // or after an OPENING paren. After a CLOSING paren `-` is subtraction, so
    // `len(x) - 1` must not lex `-1` as a negative literal.
    const prevTok = tokens[tokens.length - 1];
    const unaryMinus =
      expr.charAt(i) === '-' &&
      i + 1 < expr.length &&
      /\d/.test(expr.charAt(i + 1)) &&
      (!prevTok ||
        prevTok.type === 'op' ||
        prevTok.type === 'comma' ||
        (prevTok.type === 'paren' && prevTok.value === '('));
    if (/\d/.test(expr.charAt(i)) || unaryMinus) {
      let num = '';
      if (expr.charAt(i) === '-') { num += '-'; i++; }
      let seenDot = false;
      while (i < expr.length && /[\d.]/.test(expr.charAt(i))) {
        if (expr.charAt(i) === '.') {
          if (seenDot) break; // at most one decimal point: 1.2.3 → 1.2 then .3
          seenDot = true;
        }
        num += expr.charAt(i); i++;
      }
      tokens.push({ type: 'number', value: num });
      continue;
    }

    // Operators
    if (expr.charAt(i) === '.' && (i + 1 >= expr.length || !/\d/.test(expr.charAt(i + 1)))) {
      tokens.push({ type: 'dot', value: '.' }); i++; continue;
    }

    const twoChar = expr.substring(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(twoChar)) {
      tokens.push({ type: 'op', value: twoChar }); i += 2; continue;
    }

    if (['+', '-', '*', '/', '%', '<', '>', '!'].includes(expr.charAt(i))) {
      tokens.push({ type: 'op', value: expr.charAt(i) }); i++; continue;
    }

    if (expr.charAt(i) === '=') {
      tokens.push({ type: 'op', value: '=' }); i++; continue;
    }

    // Parens
    if (expr.charAt(i) === '(' || expr.charAt(i) === ')') {
      tokens.push({ type: 'paren', value: expr.charAt(i) }); i++; continue;
    }

    // Comma
    if (expr.charAt(i) === ',') {
      tokens.push({ type: 'comma', value: ',' }); i++; continue;
    }

    // Identifiers and keywords. A bare identifier stops at `.` — in Splunk eval the
    // period is the concatenation operator, so `event.field` is `event . field`
    // (concat the fields `event` and `field`), NOT a reference to a field literally
    // named `event.field`. Field names containing a period must be single-quoted
    // ('event.field'), which the field_ref branch above handles.
    if (/[a-zA-Z_]/.test(expr.charAt(i))) {
      let ident = '';
      while (i < expr.length && /\w/.test(expr.charAt(i))) {
        ident += expr.charAt(i); i++;
      }
      const upper = ident.toUpperCase();
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT' || upper === 'IN') {
        tokens.push({ type: 'op', value: upper });
      } else {
        tokens.push({ type: 'ident', value: ident });
      }
      continue;
    }

    // Unknown character, skip
    i++;
  }

  return tokens;
}

// ── AST ─────────────────────────────────────────────────
//
// The parser builds an AST (no event bound) so it can run once per directive,
// and the evaluator walks it per event. Keeping parse and eval separate is also
// what lets branching functions (if/case/coalesce/validate) and AND/OR evaluate
// lazily — Splunk only evaluates the branch it actually takes.

type Node =
  | { kind: 'lit'; value: EvalValue }
  | { kind: 'field'; name: string }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'arith'; op: string; left: Node; right: Node }
  | { kind: 'concat'; left: Node; right: Node }
  | { kind: 'compare'; op: string; left: Node; right: Node }
  | { kind: 'logical'; op: 'AND' | 'OR'; left: Node; right: Node }
  | { kind: 'not'; operand: Node }
  | { kind: 'neg'; operand: Node }
  | { kind: 'in'; value: Node; list: Node[]; negate: boolean };

// ── Parser ──────────────────────────────────────────────

class Parser {
  private tokens: Token[];
  private pos = 0;
  private depth = 0;
  private static readonly MAX_DEPTH = 50;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  /**
   * Take the next token. Running off the end is a syntax error in the input, not
   * a condition callers handle — every caller reached this point because `peek()`
   * showed them a token, or because the grammar requires one here. Previously the
   * out-of-range read was typed as `Token` and surfaced as a raw
   * "cannot read property 'value' of undefined" further downstream.
   */
  private consume(): Token {
    const tok = this.tokens[this.pos++];
    if (!tok) throw new Error('Unexpected end of expression');
    return tok;
  }

  private expect(type: TokenType, value?: string): Token {
    const tok = this.consume();
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new Error(`Expected ${type} ${value ?? ''}`);
    }
    return tok;
  }

  parse(): Node {
    const node = this.parseOr();
    // Reject leftover tokens rather than silently discarding them — a malformed
    // expression like `1 + 2 foo` or `len(x) y` is an error, not a truncated OK.
    const leftover = this.peek();
    if (leftover) {
      throw new Error(`Unexpected token: ${leftover.value}`);
    }
    return node;
  }

  private parseOr(): Node {
    // Depth guard only covers OR-level nesting; flat chains via parseAddSub/parseMulDiv
    // do not increment depth. The worker watchdog (5 s) is the primary protection
    // against pathological inputs that slip through.
    if (++this.depth > Parser.MAX_DEPTH) {
      throw new Error('Expression nesting depth limit exceeded (max 50)');
    }
    try {
      let left = this.parseAnd();
      while (this.peek()?.value === 'OR' || this.peek()?.value === '||') {
        this.consume();
        const right = this.parseAnd();
        left = { kind: 'logical', op: 'OR', left, right };
      }
      return left;
    } finally {
      this.depth--;
    }
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.peek()?.value === 'AND' || this.peek()?.value === '&&') {
      this.consume();
      const right = this.parseNot();
      left = { kind: 'logical', op: 'AND', left, right };
    }
    return left;
  }

  private parseNot(): Node {
    if (this.peek()?.value === 'NOT' || this.peek()?.value === '!') {
      this.consume();
      return { kind: 'not', operand: this.parseComparison() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Node {
    const left = this.parseConcat();
    const tok = this.peek();

    // IN / NOT IN
    if (tok?.type === 'op' && tok.value === 'IN') {
      this.consume();
      return this.parseInList(left, false);
    }
    if (tok?.type === 'op' && tok.value === 'NOT' && this.tokens[this.pos + 1]?.value === 'IN') {
      this.consume(); // NOT
      this.consume(); // IN
      return this.parseInList(left, true);
    }

    if (tok?.type === 'op' && ['==', '=', '!=', '<', '>', '<=', '>='].includes(tok.value)) {
      const op = this.consume().value;
      const right = this.parseConcat();
      return { kind: 'compare', op, left, right };
    }
    return left;
  }

  private parseInList(left: Node, negate: boolean): Node {
    this.expect('paren', '(');
    const list: Node[] = [];
    if (this.peek()?.type !== 'paren' || this.peek()?.value !== ')') {
      list.push(this.parseOr());
      while (this.peek()?.type === 'comma') {
        this.consume();
        list.push(this.parseOr());
      }
    }
    this.expect('paren', ')');
    return { kind: 'in', value: left, list, negate };
  }

  private parseConcat(): Node {
    let left = this.parseAddSub();
    while (this.peek()?.type === 'dot') {
      this.consume();
      const right = this.parseAddSub();
      left = { kind: 'concat', left, right };
    }
    return left;
  }

  private parseAddSub(): Node {
    let left = this.parseMulDiv();
    while (this.peek()?.type === 'op' && (this.peek()?.value === '+' || this.peek()?.value === '-')) {
      const op = this.consume().value;
      const right = this.parseMulDiv();
      left = { kind: 'arith', op, left, right };
    }
    return left;
  }

  private parseMulDiv(): Node {
    let left = this.parseUnary();
    while (this.peek()?.type === 'op' && ['*', '/', '%'].includes(this.peek()!.value)) {
      const op = this.consume().value;
      const right = this.parseUnary();
      left = { kind: 'arith', op, left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.peek()?.type === 'op' && this.peek()?.value === '-') {
      this.consume();
      return { kind: 'neg', operand: this.parsePrimary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const tok = this.peek();
    if (!tok) throw new Error('Unexpected end of expression');

    // Parenthesized expression
    if (tok.type === 'paren' && tok.value === '(') {
      this.consume();
      const val = this.parseOr();
      this.expect('paren', ')');
      return val;
    }

    // String literal
    if (tok.type === 'string') {
      return { kind: 'lit', value: this.consume().value };
    }

    // Single-quoted field reference
    if (tok.type === 'field_ref') {
      return { kind: 'field', name: this.consume().value };
    }

    // Number literal
    if (tok.type === 'number') {
      return { kind: 'lit', value: parseFloat(this.consume().value) };
    }

    // Function call or field reference
    if (tok.type === 'ident') {
      const name = this.consume().value;

      // Check for function call
      if (this.peek()?.type === 'paren' && this.peek()?.value === '(') {
        this.consume(); // (
        const args: Node[] = [];
        if (this.peek()?.type !== 'paren' || this.peek()?.value !== ')') {
          args.push(this.parseOr());
          while (this.peek()?.type === 'comma') {
            this.consume();
            args.push(this.parseOr());
          }
        }
        this.expect('paren', ')');
        return { kind: 'call', name, args };
      }

      // Boolean literals
      if (name === 'true') return { kind: 'lit', value: true };
      if (name === 'false') return { kind: 'lit', value: false };

      // Field reference
      return { kind: 'field', name };
    }

    throw new Error(`Unexpected token: ${tok.value}`);
  }
}

// ── Evaluator ───────────────────────────────────────────

interface EvalCtx {
  event: SplunkEvent;
  /** Epoch ms standing in for the current time — injected, never read from the clock here. */
  now: number;
  onStubWarning?: ((fn: string) => void) | undefined;
}

function getField(event: SplunkEvent, name: string): EvalValue {
  if (name === '_raw') return event._raw;
  if (name === '_time') return event._time ? event._time.getTime() / 1000 : null;
  const val = getOwnField(event.fields, name);
  // host/source/sourcetype/index are default fields at search time, so an eval
  // may read them directly (`EVAL-idx = index`, `EVAL-x = if(sourcetype=="…")`).
  if (val === undefined) return getMetadataField(event, name) ?? null;
  if (Array.isArray(val)) return val;
  return val;
}

function evalNode(node: Node, ctx: EvalCtx): EvalValue {
  switch (node.kind) {
    case 'lit':
      return node.value;
    case 'field':
      return getField(ctx.event, node.name);
    case 'concat': {
      // Splunk propagates null through the dot operator: concatenating against a
      // field that does not exist yields no value at all, so the EVAL writes no
      // field. Coercing the missing side to "" instead produced a present-but-
      // empty field, which inverts the standard `if(isnull(x), …)` guard --
      // exactly the case a config author wrote the guard for.
      const left = evalNode(node.left, ctx);
      if (left === null || left === undefined) return null;
      const right = evalNode(node.right, ctx);
      if (right === null || right === undefined) return null;
      return toStr(left) + toStr(right);
    }
    case 'arith': {
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      return node.op === '+' ? addOrConcat(l, r) : arith(l, r, node.op as '-' | '*' | '/' | '%');
    }
    case 'compare':
      return compare(evalNode(node.left, ctx), evalNode(node.right, ctx), node.op);
    case 'neg': {
      // NULL and non-numeric operands propagate as NULL (Splunk): -null, -"abc" = null.
      const n = numArg(evalNode(node.operand, ctx));
      return n === null ? null : -n;
    }
    case 'not':
      return !toBool(evalNode(node.operand, ctx));
    case 'logical': {
      // Short-circuit: Splunk does not evaluate the right operand once the left
      // settles the result. Both operators yield a boolean.
      const left = evalNode(node.left, ctx);
      if (node.op === 'OR') return toBool(left) ? true : toBool(evalNode(node.right, ctx));
      return !toBool(left) ? false : toBool(evalNode(node.right, ctx));
    }
    case 'in': {
      const left = evalNode(node.value, ctx);
      // `some` stops at the first match — no need to evaluate the rest of the list.
      const match = node.list.some((n) => compare(left, evalNode(n, ctx), '='));
      return node.negate ? !match : match;
    }
    case 'call':
      return evalCall(node.name, node.args, ctx);
  }
}

/**
 * Walk `nodes` two at a time, yielding only whole pairs. case() and validate()
 * both take (test, result) couples, and both ignore a dangling final argument.
 */
function* pairs(nodes: Node[]): Generator<[Node, Node]> {
  for (let i = 0; i + 1 < nodes.length; i += 2) {
    const test = nodes[i];
    const result = nodes[i + 1];
    if (test === undefined || result === undefined) return;
    yield [test, result];
  }
}

/**
 * Dispatch a function call. Branching functions evaluate their argument *nodes*
 * lazily (only the taken branch), matching Splunk; everything else evaluates all
 * arguments first and hands the values to {@link evalBuiltin}.
 */
function evalCall(name: string, argNodes: Node[], ctx: EvalCtx): EvalValue {
  const fn = name.toLowerCase();
  switch (fn) {
    case 'if': {
      // `if()` with no condition at all has nothing to branch on; treat it the
      // way the missing then/else branches below are already treated.
      const cond = argNodes[0];
      if (cond === undefined) return null;
      const taken = toBool(evalNode(cond, ctx)) ? argNodes[1] : argNodes[2];
      return taken !== undefined ? evalNode(taken, ctx) : null;
    }
    case 'case':
      for (const [test, result] of pairs(argNodes)) {
        if (toBool(evalNode(test, ctx))) return evalNode(result, ctx);
      }
      return null;
    case 'validate':
      // validate() is case() inverted: it returns the result of the first test
      // that FAILS.
      for (const [test, result] of pairs(argNodes)) {
        if (!toBool(evalNode(test, ctx))) return evalNode(result, ctx);
      }
      return null;
    case 'coalesce':
      for (const n of argNodes) {
        const v = evalNode(n, ctx);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    default:
      return evalBuiltin(fn, argNodes.map((n) => evalNode(n, ctx)), ctx);
  }
}

/** Non-branching functions: all arguments are already evaluated. */
function evalBuiltin(fn: string, args: EvalValue[], ctx: EvalCtx): EvalValue {
  switch (fn) {
    case 'nullif': return toStr(args[0]) === toStr(args[1]) ? null : args[0] ?? null;

    // String — an absent argument propagates NULL rather than being coerced to
    // "". `len(nonexistent)` is null, not 0; a plausible-looking 0 is worse than
    // no field at all, because nothing about it says the field was missing (#211).
    // The predicates below (match, like, isnull, typeof) deliberately do not
    // propagate: they answer a question about the value, including its absence.
    case 'lower': { const s = strArg(args[0]); return s === null ? null : s.toLowerCase(); }
    case 'upper': { const s = strArg(args[0]); return s === null ? null : s.toUpperCase(); }
    case 'len': { const s = strArg(args[0]); return s === null ? null : s.length; }
    case 'substr': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const start = toNum(args[1]);
      const startIdx = start > 0 ? start - 1 : s.length + start;
      const len = args[2] !== undefined ? toNum(args[2]) : undefined;
      return len !== undefined ? s.substring(startIdx, startIdx + len) : s.substring(startIdx);
    }
    case 'replace': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const regex = safeRegex(toStr(args[1]), 'g');
      if (!regex) return s;
      return s.replace(regex, splunkReplacementToJs(toStr(args[2])));
    }
    case 'trim': { const s = strArg(args[0]); return s === null ? null : s.trim(); }
    case 'ltrim': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const chars = args[1] !== undefined ? toStr(args[1]) : ' \t\n\r';
      let i = 0;
      while (i < s.length && chars.includes(s.charAt(i))) i++;
      return s.substring(i);
    }
    case 'rtrim': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const chars = args[1] !== undefined ? toStr(args[1]) : ' \t\n\r';
      let i = s.length - 1;
      while (i >= 0 && chars.includes(s.charAt(i))) i--;
      return s.substring(0, i + 1);
    }
    case 'urldecode': {
      const s = strArg(args[0]);
      if (s === null) return null;
      try { return decodeURIComponent(s); }
      catch { return s; }
    }
    case 'split': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const delim = toStr(args[1]);
      return s.split(delim);
    }
    case 'mvjoin': {
      if (args[0] === null || args[0] === undefined) return null;
      const v = toMv(args[0]);
      return v.join(toStr(args[1]));
    }

    // Type
    case 'tonumber': {
      const val = toStr(args[0]).trim();
      const base = args[1] !== undefined ? Math.floor(toNum(args[1])) : 10;
      if (base === 10) {
        if (!/^-?\d+(\.\d+)?$/.test(val)) return null;
        return parseFloat(val);
      }
      const validChars = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
      if (!new RegExp(`^[${validChars}]+$`, 'i').test(val)) return null;
      const n = parseInt(val, base);
      return isNaN(n) ? null : n;
    }
    case 'tostring': {
      if (args[0] === null || args[0] === undefined) return null;
      const val = numArg(args[0]);
      // The numeric formats only apply to numeric input; a non-numeric value is
      // passed through unchanged rather than coerced to 0 (tostring("abc","commas") → "abc").
      if (args[1] !== undefined && val !== null) {
        const format = toStr(args[1]);
        if (format === 'hex') return '0x' + Math.floor(val).toString(16);
        if (format === 'commas') {
          // Thousands separators, up to two decimals. Splunk shows no decimals
          // for integers (e.g. 12,345) but keeps fractional precision (rounded
          // to 2 places) when present.
          return val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        }
        if (format === 'duration') {
          const pad = (n: number) => String(n).padStart(2, '0');
          const total = Math.floor(Math.abs(val));
          const days = Math.floor(total / 86400);
          const h = Math.floor((total % 86400) / 3600);
          const m = Math.floor((total % 3600) / 60);
          const s = total % 60;
          const sign = val < 0 ? '-' : '';
          const hms = `${pad(h)}:${pad(m)}:${pad(s)}`;
          return days > 0 ? `${sign}${days}+${hms}` : `${sign}${hms}`;
        }
      }
      return toStr(args[0]);
    }
    case 'typeof': {
      // Splunk returns "Number" | "String" | "Bool" | "Invalid"
      // (a null / nonexistent field is "Invalid", not a separate null type).
      if (args[0] === null || args[0] === undefined) return 'Invalid';
      if (typeof args[0] === 'number') return 'Number';
      if (typeof args[0] === 'boolean') return 'Bool';
      if (Array.isArray(args[0])) return 'MultiValue';
      return 'String';
    }
    case 'isnull': return args[0] === null || args[0] === undefined;
    case 'isnotnull': return args[0] !== null && args[0] !== undefined;
    case 'isint': return isNumericValue(args[0]) && Number.isInteger(Number(args[0]));
    case 'isnum': return isNumericValue(args[0]);
    // Informational functions mirror `typeof`'s type model: they report the
    // value's actual type rather than what it could be coerced to.
    case 'isbool': return typeof args[0] === 'boolean';
    case 'isstr': return typeof args[0] === 'string';

    // Math — a non-numeric (or NULL) argument yields NULL rather than 0.
    case 'abs': { const n = numArg(args[0]); return n === null ? null : Math.abs(n); }
    case 'ceiling': case 'ceil': { const n = numArg(args[0]); return n === null ? null : Math.ceil(n); }
    case 'floor': { const n = numArg(args[0]); return n === null ? null : Math.floor(n); }
    case 'round': {
      const val = numArg(args[0]);
      if (val === null) return null;
      const decimals = args[1] !== undefined ? numArg(args[1]) ?? 0 : 0;
      const factor = Math.pow(10, decimals);
      // Splunk rounds halves away from zero; JS Math.round rounds toward +∞.
      const scaled = val * factor;
      return (Math.sign(scaled) * Math.round(Math.abs(scaled))) / factor;
    }
    case 'sqrt': { const n = numArg(args[0]); return n === null ? null : Math.sqrt(n); }
    case 'pow': {
      const base = numArg(args[0]);
      const exp = numArg(args[1]);
      return base === null || exp === null ? null : Math.pow(base, exp);
    }
    case 'log': {
      const val = numArg(args[0]);
      const base = args[1] !== undefined ? numArg(args[1]) : 10;
      return val === null || base === null ? null : Math.log(val) / Math.log(base);
    }
    case 'ln': { const n = numArg(args[0]); return n === null ? null : Math.log(n); }
    case 'exp': { const n = numArg(args[0]); return n === null ? null : Math.exp(n); }
    case 'pi': return Math.PI;
    case 'min': return minMax(args, 'min');
    case 'max': return minMax(args, 'max');
    case 'random': return Math.floor(Math.random() * 2147483648); // 0 .. 2^31-1, like Splunk

    // Precision control — not simulated. Both return the value unrounded, which
    // is the one stub shape that looks like a correct answer rather than an
    // obvious placeholder: `sigfig(3.14159)` showing `3.14159` reads as a
    // working computation. So they warn, like every other unsimulated function.
    case 'exact':
      ctx.onStubWarning?.('exact');
      return numArg(args[0]);
    case 'sigfig':
      ctx.onStubWarning?.('sigfig');
      return numArg(args[0]);

    // Multivalue
    case 'mvcount': {
      // Splunk: a single value → 1, multiple → count, no values → NULL (not 0).
      const m = toMv(args[0]);
      return m.length === 0 ? null : m.length;
    }
    case 'mvindex': {
      const mv = toMv(args[0]);
      const n = mv.length;
      // Splunk mvindex is 0-based; negative indices count from the end (-1 = last).
      const norm = (idx: number) => (idx < 0 ? n + idx : idx);
      const start = norm(toNum(args[1]));
      const end = args[2] !== undefined ? norm(toNum(args[2])) : start;
      // Out-of-range or inverted ranges yield NULL.
      if (start < 0 || start >= n || end < 0 || end >= n || end < start) return null;
      return start === end ? mv[start] ?? null : mv.slice(start, end + 1);
    }
    case 'mvfilter':
      ctx.onStubWarning?.('mvfilter');
      return toMv(args[0]);
    case 'mvappend': return args.flatMap(toMv);
    case 'mvdedup': return [...new Set(toMv(args[0]))];
    case 'mvfind': {
      const mv = toMv(args[0]);
      const regex = safeRegex(toStr(args[1]));
      if (!regex) return null;
      const idx = mv.findIndex((v) => regex.test(v));
      return idx >= 0 ? idx : null;
    }
    case 'mvsort': return [...toMv(args[0])].sort();
    case 'mvzip': {
      const a = toMv(args[0]);
      const b = toMv(args[1]);
      const delim = args[2] !== undefined ? toStr(args[2]) : ',';
      // Splunk mvzip behaves like a zip: it stops at the shorter field rather
      // than padding out to the longer one.
      const len = Math.min(a.length, b.length);
      const result: string[] = [];
      for (let i = 0; i < len; i++) {
        result.push(a[i] + delim + b[i]);
      }
      return result;
    }

    // Crypto — not simulated (crypto.subtle is async; eval is sync).
    // Return a visible placeholder so the field is set and users see the stub rather than a silent deletion.
    case 'md5':   ctx.onStubWarning?.('md5');    return '[md5() not simulated]';
    case 'sha1':  ctx.onStubWarning?.('sha1');   return '[sha1() not simulated]';
    case 'sha256': ctx.onStubWarning?.('sha256'); return '[sha256() not simulated]';
    case 'sha512': ctx.onStubWarning?.('sha512'); return '[sha512() not simulated]';

    // Time
    case 'now': return Math.floor(ctx.now / 1000);
    case 'time': return Math.floor(ctx.now / 1000);
    case 'strftime': {
      // A non-numeric or absent epoch is NULL rather than 1970 — coercing to 0
      // renders a confident, wrong timestamp for a field that isn't there.
      const epoch = numArg(args[0]);
      if (epoch === null) return null;
      const format = toStr(args[1]);
      const date = new Date(epoch * 1000);
      return formatStrftime(date, format);
    }
    case 'strptime':
      ctx.onStubWarning?.('strptime');
      return strArg(args[0]);
    case 'relative_time':
      ctx.onStubWarning?.('relative_time');
      return toNum(args[0]);

    // Other
    case 'null': return null;
    // `true()`/`false()` parse as calls, not as the bare boolean literals the
    // parser already handles — and `true()` is the idiomatic way to write the
    // trailing default branch of a case(). Without these it evaluated to null,
    // the branch never fired, and case() fell off the end returning nothing for
    // precisely the inputs the author wrote a fallback for (#165).
    case 'true': return true;
    case 'false': return false;
    case 'like': {
      const value = toStr(args[0]);
      // Escape regex metacharacters first, then translate SQL-style wildcards
      const pattern = toStr(args[1])
        .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
        .replace(/_/g, '.');
      // Splunk's like() is case-sensitive.
      const regex = safeRegex(`^${pattern}$`);
      return regex ? regex.test(value) : false;
    }
    case 'match': {
      const regex = safeRegex(toStr(args[1]));
      return regex ? regex.test(toStr(args[0])) : false;
    }
    case 'cidrmatch':
      ctx.onStubWarning?.('cidrmatch');
      return false;
    case 'searchmatch':
      ctx.onStubWarning?.('searchmatch');
      return false;

    default:
      // Unknown or not-yet-simulated function — surface a warning rather than
      // silently returning null (which looks like the field just didn't compute).
      ctx.onStubWarning?.(fn);
      return null;
  }
}

// ── Helpers ─────────────────────────────────────────────

function toBool(v: EvalArg): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0 && v !== '0' && v.toLowerCase() !== 'false';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function toNum(v: EvalArg): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  if (Array.isArray(v)) return v.length > 0 ? toNum(v[0]) : 0;
  return 0;
}

/**
 * Translate a Splunk `replace()` replacement string into the JS equivalent.
 *
 * Splunk uses PCRE-style `\1` backreferences, while `String.prototype.replace`
 * uses `$1` and additionally treats `$&`, `` $` ``, `$'` and `$$` as
 * substitutions Splunk has no notion of. So `\N` becomes `$N`, `\0` becomes the
 * whole match, and any literal `$` is escaped to survive verbatim.
 */
function splunkReplacementToJs(replacement: string): string {
  let out = '';
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement.charAt(i);
    if (c === '$') {
      out += '$$'; // a literal dollar, not a JS substitution
      continue;
    }
    if (c === '\\' && i + 1 < replacement.length) {
      const next = replacement.charAt(i + 1);
      if (next >= '0' && next <= '9') {
        let digits = '';
        while (i + 1 < replacement.length && replacement.charAt(i + 1) >= '0' && replacement.charAt(i + 1) <= '9') {
          digits += replacement.charAt(i + 1);
          i++;
        }
        // PCRE `\0` is the whole match; JS spells that `$&`.
        out += Number(digits) === 0 ? '$&' : `$${digits}`;
        continue;
      }
      if (next === '\\') {
        out += '\\';
        i++;
        continue;
      }
      out += `\\${next}`;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function toStr(v: EvalArg): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(' ');
  return String(v);
}

/**
 * The `+` operator. Splunk propagates NULL through arithmetic (null + x = null),
 * adds when both operands are numeric, and otherwise CONCATENATES strings
 * (`"a" + "b"` → "ab"). `.` is the dedicated concat operator, but `+` falls back
 * to concatenation rather than coercing strings to 0.
 */
function addOrConcat(l: EvalArg, r: EvalArg): EvalValue {
  if (l === null || l === undefined || r === null || r === undefined) return null;
  if (isNumericValue(l) && isNumericValue(r)) return toNum(l) + toNum(r);
  return toStr(l) + toStr(r);
}

/**
 * Numeric operand for arithmetic and math functions. Unlike {@link toNum} it
 * does NOT coerce a non-numeric value to 0 — it returns null so the caller can
 * propagate NULL the way Splunk does (`"abc" * 2` and `abs("foo")` are null, not
 * 0). Booleans still coerce (true→1, false→0), matching Splunk.
 */
/**
 * String operand for the string functions. Unlike {@link toStr} it does NOT
 * coerce an absent value to "" — it returns null so the caller can propagate
 * NULL the way Splunk does (`len(nonexistent)` is null, not 0).
 *
 * The distinction that makes this work is drawn in {@link getField}: a field
 * that is present and empty evaluates to "", a field that is absent evaluates
 * to null. So `len(empty_field)` is still 0 and only the absent case propagates.
 */
function strArg(v: EvalArg): string | null {
  if (v === null || v === undefined) return null;
  return toStr(v);
}

function numArg(v: EvalArg): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.length > 0 ? numArg(v[0]) : null;
  return isNumericString(v) ? Number(v) : null;
}

/** `-`, `*`, `/`, `%` with NULL propagation (null or non-numeric operand → null). */
function arith(l: EvalArg, r: EvalArg, op: '-' | '*' | '/' | '%'): EvalValue {
  const a = numArg(l);
  const b = numArg(r);
  if (a === null || b === null) return null;
  switch (op) {
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b !== 0 ? a / b : null;
    case '%': return b !== 0 ? a % b : null;
  }
}

function toMv(v: EvalArg): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === null || v === undefined) return [];
  return [String(v)];
}

function isNumericString(v: EvalArg): boolean {
  if (typeof v !== 'string' || v === '') return false;
  return !isNaN(Number(v));
}

/**
 * True when the value is genuinely numeric — a number, or a string that parses
 * cleanly as one. Used by isnum()/isint(); unlike toNum() it does not coerce
 * non-numeric input to 0 (which made isnum("abc") wrongly return true).
 */
function isNumericValue(v: EvalArg): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return isNumericString(v);
}

/**
 * Splunk ordering for min()/max(): numeric values compare numerically, strings
 * compare lexicographically, and any number is considered less than any string.
 * Returns <0 if a<b, >0 if a>b, 0 if equal.
 */
function compareEvalValues(a: EvalArg, b: EvalArg): number {
  const aNum = isNumericValue(a);
  const bNum = isNumericValue(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1; // number < string
  if (bNum) return 1;
  const as = toStr(a);
  const bs = toStr(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** min()/max() over scalars and multivalue args, using Splunk's mixed-type ordering. */
function minMax(args: EvalValue[], which: 'min' | 'max'): EvalValue {
  let best: EvalValue | undefined;
  for (const v of args.flatMap((a) => (Array.isArray(a) ? a : [a]))) {
    // NULLs are not candidates: min(null, 3) is 3, and min(null) is NULL.
    if (v === null || v === undefined) continue;
    if (best === undefined) { best = v; continue; }
    const cmp = compareEvalValues(v, best);
    if (which === 'min' ? cmp < 0 : cmp > 0) best = v;
  }
  return best ?? null;
}

function compare(left: EvalArg, right: EvalArg, op: string): boolean {
  // Splunk eval: compare numerically only when BOTH sides are numeric (a number
  // or a string that parses cleanly as one). Otherwise compare as strings. This
  // avoids coercing a non-numeric operand to 0 — `"abc" == 0` must be false, not
  // true (which is what `0 === toNum("abc")` used to produce).
  const bothNumeric = isNumericValue(left) && isNumericValue(right);

  const l = bothNumeric ? Number(left) : toStr(left);
  const r = bothNumeric ? Number(right) : toStr(right);

  switch (op) {
    case '==': case '=': return l === r;
    case '!=': return l !== r;
    case '<': return l < r;
    case '>': return l > r;
    case '<=': return l <= r;
    case '>=': return l >= r;
    default: return false;
  }
}

/** Parse an eval expression into an AST. Throws on a syntax error. */
function parseExpression(expr: string): Node {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  return parser.parse();
}

export function evaluateExpression(
  expr: string,
  event: SplunkEvent,
  onStubWarning?: (fn: string) => void,
  now: number = Date.now(),
): EvalValue {
  return evalNode(parseExpression(expr), { event, now, onStubWarning });
}
