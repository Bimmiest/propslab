// The eval lexer: expression text in, a flat token list out. It decides what a
// character run IS (string literal, quoted field, number, operator) and nothing
// about how tokens combine; that is the parser's job.

export type TokenType = 'string' | 'number' | 'ident' | 'field_ref' | 'op' | 'paren' | 'comma' | 'dot';

export interface Token {
  type: TokenType;
  value: string;
}

/**
 * True when `tok` completes a value, so what follows it is in operator
 * position: a literal, a field, or a closing paren.
 */
function endsValue(tok: Token | undefined): boolean {
  return (
    tok !== undefined &&
    (tok.type === 'string' ||
      tok.type === 'number' ||
      tok.type === 'ident' ||
      tok.type === 'field_ref' ||
      (tok.type === 'paren' && tok.value === ')'))
  );
}

/**
 * One lexing rule: if the text at `i` is its kind of token, push the token and
 * return the index just past it; otherwise return null and push nothing.
 *
 * Character access goes through `charAt` rather than `expr[i]`: every read here
 * is already inside an `i < expr.length` bound, and charAt returns a plain string
 * for an in-bounds index instead of `string | undefined`. The lookaheads at
 * `i + 1` are the only reads that can run off the end, and each tests the
 * result against a literal or `\d` — where charAt's `''` is the answer we want
 * anyway.
 */
type Lexer = (expr: string, i: number, tokens: Token[]) => number | null;

/**
 * Double-quoted string literals. Splunk eval gives only `\"` and `\\` a
 * special meaning inside a literal and passes every other escape through
 * intact — string literals are the way regexes reach match()/replace()/rex(),
 * so collapsing `\d` to `d` would silently rewrite the user's pattern. (The
 * official replace() docs example is `"^(\d{1,2})/(\d{1,2})/"`, with single
 * backslashes.)
 */
const lexString: Lexer = (expr, start, tokens) => {
  if (expr.charAt(start) !== '"') return null;
  let str = '';
  let i = start + 1;
  while (i < expr.length && expr.charAt(i) !== '"') {
    if (expr.charAt(i) === '\\' && i + 1 < expr.length && (expr.charAt(i + 1) === '"' || expr.charAt(i + 1) === '\\')) {
      str += expr.charAt(i + 1);
      i += 2;
    } else {
      str += expr.charAt(i);
      i++;
    }
  }
  // Running off the end without a closing quote is a syntax error, so a typo'd
  // `"abc` is reported rather than evaluated as the rest of the expression.
  if (i >= expr.length) throw new Error('Unterminated string literal');
  tokens.push({ type: 'string', value: str });
  return i + 1; // skip closing quote
};

/** Single-quoted field references (Splunk uses '' for field names with special chars). */
const lexQuotedField: Lexer = (expr, start, tokens) => {
  if (expr.charAt(start) !== "'") return null;
  const end = expr.indexOf("'", start + 1);
  // Same rule as a string literal: no closing quote is an error, not a
  // field named after the rest of the expression.
  if (end === -1) throw new Error('Unterminated quoted field name');
  tokens.push({ type: 'field_ref', value: expr.slice(start + 1, end) });
  return end + 1; // skip closing quote
};

/**
 * Numbers. A leading `-` is folded into a numeric literal only when a value
 * cannot already be in progress — at the start, after an operator or comma,
 * or after an OPENING paren. After a CLOSING paren `-` is subtraction, so
 * `len(x) - 1` must not lex `-1` as a negative literal.
 *
 * A leading `.` starts a number (`.5`) under the same condition. Where a
 * value IS in progress the `.` is the concatenation operator, so `a.5` stays
 * `a . 5` and `"x".5` stays `"x" . 5`.
 *
 * The concatenation `.` is a binary operator like the rest, so a value is
 * expected after it too: `"x" . .5` is a concatenation with 0.5, and
 * `"x" . -1` with -1, not a subtraction.
 */
const lexNumber: Lexer = (expr, start, tokens) => {
  const prevTok = tokens[tokens.length - 1];
  const valueExpected =
    !prevTok ||
    prevTok.type === 'op' ||
    prevTok.type === 'dot' ||
    prevTok.type === 'comma' ||
    (prevTok.type === 'paren' && prevTok.value === '(');
  const c = expr.charAt(start);
  const nextIsDigit = /\d/.test(expr.charAt(start + 1));
  const unaryMinus = c === '-' && start + 1 < expr.length && nextIsDigit && valueExpected;
  const leadingDot = c === '.' && nextIsDigit && valueExpected;
  if (!/\d/.test(c) && !unaryMinus && !leadingDot) return null;

  let i = start;
  let num = '';
  if (c === '-') { num += '-'; i++; }
  let seenDot = false;
  while (i < expr.length && /[\d.]/.test(expr.charAt(i))) {
    if (expr.charAt(i) === '.') {
      // A second decimal point glued to the literal (`1.2.3`) is a malformed
      // number, not `1.2 . 3`: without this the concatenation rule below
      // would take the second `.` and quietly produce "1.23".
      if (seenDot) {
        if (/\d/.test(expr.charAt(i + 1))) {
          throw new Error(`Malformed number: ${num}${/^[\d.]*/.exec(expr.slice(i))?.[0] ?? ''}`);
        }
        break;
      }
      seenDot = true;
    }
    num += expr.charAt(i); i++;
  }
  tokens.push({ type: 'number', value: num });
  return i;
};

const TWO_CHAR_OPS = ['==', '!=', '>=', '<=', '&&', '||'];
const ONE_CHAR_OPS = ['+', '-', '*', '/', '%', '<', '>', '!', '='];

/** Operators, parens and commas. Any `.` the number rule did not take is concatenation. */
const lexPunctuation: Lexer = (expr, i, tokens) => {
  const c = expr.charAt(i);
  if (c === '.') {
    tokens.push({ type: 'dot', value: '.' });
    return i + 1;
  }
  const twoChar = expr.substring(i, i + 2);
  if (TWO_CHAR_OPS.includes(twoChar)) {
    tokens.push({ type: 'op', value: twoChar });
    return i + 2;
  }
  if (ONE_CHAR_OPS.includes(c)) tokens.push({ type: 'op', value: c });
  else if (c === '(' || c === ')') tokens.push({ type: 'paren', value: c });
  else if (c === ',') tokens.push({ type: 'comma', value: ',' });
  else return null;
  return i + 1;
};

/**
 * Whether the word `upper` (already upper-cased) is an operator here.
 *
 * The word operators are contextual. AND, OR, XOR, IN and LIKE are
 * all binary, so they can only be operators straight after a complete
 * value; anywhere a value is expected the word is an ordinary identifier —
 * a field named `xor` or `like`, or a function call when `(` follows, as
 * in `in(x, "a", "b")` or `like(x, "a%")`.
 * NOT is the exception: it is a prefix operator, so value position is
 * exactly where it is legitimate, and after a value it is the NOT of
 * `x NOT IN (...)`. It stays a keyword everywhere.
 */
function isWordOperator(upper: string, tokens: Token[]): boolean {
  if (upper === 'NOT') return true;
  const prevTok = tokens[tokens.length - 1];
  if (endsValue(prevTok) && ['AND', 'OR', 'IN', 'LIKE', 'XOR'].includes(upper)) return true;
  // The IN of `x NOT IN (...)` follows NOT, not a value, so the rule above
  // alone would lex it as an identifier in the user's casing, and `x not in
  // (...)` would not parse. A NOT that itself follows a value can only be the
  // NOT of NOT IN, so the
  // word after it is the operator in any case. A prefix NOT (`NOT in(x,
  // "a")`, `NOT in`) does not follow a value, so the function form and a
  // field named `in` are unaffected.
  const afterInfixNot =
    prevTok?.type === 'op' && prevTok.value === 'NOT' && endsValue(tokens[tokens.length - 2]);
  return afterInfixNot && upper === 'IN';
}

/**
 * Identifiers and keywords. A bare identifier stops at `.` — in Splunk eval the
 * period is the concatenation operator, so `event.field` is `event . field`
 * (concat the fields `event` and `field`), NOT a reference to a field literally
 * named `event.field`. Field names containing a period must be single-quoted
 * ('event.field'), which lexQuotedField handles.
 */
const lexWord: Lexer = (expr, start, tokens) => {
  if (!/[a-zA-Z_]/.test(expr.charAt(start))) return null;
  const ident = /^\w+/.exec(expr.slice(start))?.[0] ?? '';
  const upper = ident.toUpperCase();
  tokens.push(isWordOperator(upper, tokens) ? { type: 'op', value: upper } : { type: 'ident', value: ident });
  return start + ident.length;
};

const LEXERS: readonly Lexer[] = [lexString, lexQuotedField, lexNumber, lexPunctuation, lexWord];

/** Lex an eval expression. */
export function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    if (/\s/.test(expr.charAt(i))) { i++; continue; }
    let next: number | null = null;
    for (const lex of LEXERS) {
      next = lex(expr, i, tokens);
      if (next !== null) break;
    }
    // Anything else is not part of eval syntax: an expression the simulator
    // does not understand is reported, not evaluated as something else.
    if (next === null) throw new Error(`Unexpected character: ${expr.charAt(i)}`);
    i = next;
  }

  return tokens;
}
