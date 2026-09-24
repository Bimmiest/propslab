// The eval parser: tokens in, an AST out, with no event bound. Parsing once per
// directive and walking the tree per event is what the evaluator relies on.

import type { EvalValue } from './values';
import { tokenize, type Token, type TokenType } from './tokenizer';

// ── AST ─────────────────────────────────────────────────
//
// The parser builds an AST (no event bound) so it can run once per directive,
// and the evaluator walks it per event. Keeping parse and eval separate is also
// what lets branching functions (if/case/coalesce/validate) and AND/OR evaluate
// lazily — Splunk only evaluates the branch it actually takes.

export type Node =
  | { kind: 'lit'; value: EvalValue }
  | { kind: 'field'; name: string }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'arith'; op: string; left: Node; right: Node }
  | { kind: 'concat'; left: Node; right: Node }
  | { kind: 'compare'; op: string; left: Node; right: Node }
  | { kind: 'logical'; op: 'AND' | 'OR' | 'XOR'; left: Node; right: Node }
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
      // XOR shares OR's precedence level in the SPL eval operator table, and
      // like OR it is left-associative (#312).
      let left = this.parseAnd();
      for (let tok = this.peek(); tok?.type === 'op' && ['OR', '||', 'XOR'].includes(tok.value); tok = this.peek()) {
        this.consume();
        const right = this.parseAnd();
        left = { kind: 'logical', op: tok.value === 'XOR' ? 'XOR' : 'OR', left, right };
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
    // NOT applies to a NOT expression, not only to a comparison: `NOT NOT x`
    // used to hand the second NOT to parseComparison, which cannot start with
    // an operator, and threw (#312). Counted in a loop rather than by recursion
    // so a long run of NOTs cannot exhaust the stack past the depth guard.
    let nots = 0;
    while (this.peek()?.type === 'op' && (this.peek()?.value === 'NOT' || this.peek()?.value === '!')) {
      this.consume();
      nots++;
    }
    let node = this.parseComparison();
    for (; nots > 0; nots--) node = { kind: 'not', operand: node };
    return node;
  }

  private parseComparison(): Node {
    const left = this.parseConcat();
    const tok = this.peek();

    // IN / NOT IN
    if (tok?.type === 'op' && tok.value === 'IN') {
      this.consume();
      return this.parseInList(left, false);
    }
    // The lexer reads the word after an infix NOT as the IN operator whatever
    // its casing (#337), so this matches an operator token, never a field that
    // happens to be named `IN`.
    const next = this.tokens[this.pos + 1];
    if (tok?.type === 'op' && tok.value === 'NOT' && next?.type === 'op' && next.value === 'IN') {
      this.consume(); // NOT
      this.consume(); // IN
      return this.parseInList(left, true);
    }

    // `a LIKE b` is the like() function written as a comparison operator, in
    // the same precedence tier as `=`/`!=` (#312). It becomes a call so the
    // operator and the function cannot drift apart: same wildcard translation,
    // same ReDoS handling for runs of `%`, same regex-failure diagnostic.
    if (tok?.type === 'op' && tok.value === 'LIKE') {
      this.consume();
      const right = this.parseConcat();
      return { kind: 'call', name: 'like', args: [left, right] };
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

      // Check for function call. `like(...)` and `in(...)` arrive here too: the
      // lexer only reads those words as operators after a value (#332).
      if (this.peek()?.type === 'paren' && this.peek()?.value === '(') {
        const call = this.parseCall(name);
        // in(<value>, <list>...) is the IN operator written as a function; it
        // becomes the same node so the two cannot disagree about matching.
        if (name.toLowerCase() === 'in') {
          const [value, ...list] = call.args;
          if (value === undefined || list.length === 0) {
            throw new Error('in() requires a value and at least one list item');
          }
          return { kind: 'in', value, list, negate: false };
        }
        return call;
      }

      // Boolean literals
      if (name === 'true') return { kind: 'lit', value: true };
      if (name === 'false') return { kind: 'lit', value: false };

      // Field reference
      return { kind: 'field', name };
    }

    throw new Error(`Unexpected token: ${tok.value}`);
  }

  /** The argument list of a call to `name`; the next token is its `(`. */
  private parseCall(name: string): Extract<Node, { kind: 'call' }> {
    this.expect('paren', '(');
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
}

/** Parse an eval expression into an AST. Throws on a syntax error. */
export function parseExpression(expr: string): Node {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  return parser.parse();
}
