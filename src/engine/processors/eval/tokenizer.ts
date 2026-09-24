// The eval lexer: expression text in, a flat token list out. It decides what a
// character run IS (string literal, quoted field, number, operator) and nothing
// about how tokens combine; that is the parser's job.

export type TokenType = 'string' | 'number' | 'ident' | 'field_ref' | 'op' | 'paren' | 'comma' | 'dot';

export interface Token {
  type: TokenType;
  value: string;
}

/**
 * Lex an eval expression.
 *
 * Character access goes through `charAt` rather than `expr[i]`: every read here
 * is already inside an `i < expr.length` loop, and charAt returns a plain string
 * for an in-bounds index instead of `string | undefined`. The lookaheads at
 * `i + 1` are the only reads that can run off the end, and each tests the
 * result against a literal or `\d` — where charAt's `''` is the answer we want
 * anyway.
 */
export function tokenize(expr: string): Token[] {
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
      // Running off the end without a closing quote is a syntax error. It used
      // to be accepted as a literal holding the rest of the expression, so a
      // typo'd `"abc` evaluated instead of being reported (#312).
      if (i >= expr.length) throw new Error('Unterminated string literal');
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
      // Same rule as a string literal: no closing quote is an error, not a
      // field named after the rest of the expression (#312).
      if (i >= expr.length) throw new Error('Unterminated quoted field name');
      i++; // skip closing quote
      tokens.push({ type: 'field_ref', value: name });
      continue;
    }

    // Numbers. A leading `-` is folded into a numeric literal only when a value
    // cannot already be in progress — at the start, after an operator or comma,
    // or after an OPENING paren. After a CLOSING paren `-` is subtraction, so
    // `len(x) - 1` must not lex `-1` as a negative literal.
    //
    // A leading `.` starts a number (`.5`) under the same condition. Where a
    // value IS in progress the `.` is the concatenation operator, so `a.5` stays
    // `a . 5` and `"x".5` stays `"x" . 5`. Before this, `.5` fell through to the
    // unknown-character skip and `.5 * 2` quietly evaluated to 10 (#312).
    const prevTok = tokens[tokens.length - 1];
    const valueExpected =
      !prevTok ||
      prevTok.type === 'op' ||
      prevTok.type === 'comma' ||
      (prevTok.type === 'paren' && prevTok.value === '(');
    const unaryMinus =
      expr.charAt(i) === '-' &&
      i + 1 < expr.length &&
      /\d/.test(expr.charAt(i + 1)) &&
      valueExpected;
    const leadingDot = expr.charAt(i) === '.' && /\d/.test(expr.charAt(i + 1)) && valueExpected;
    if (/\d/.test(expr.charAt(i)) || unaryMinus || leadingDot) {
      let num = '';
      if (expr.charAt(i) === '-') { num += '-'; i++; }
      let seenDot = false;
      while (i < expr.length && /[\d.]/.test(expr.charAt(i))) {
        if (expr.charAt(i) === '.') {
          // A second decimal point glued to the literal (`1.2.3`) is a malformed
          // number, not `1.2 . 3`: without this the concatenation rule below
          // would take the second `.` and quietly produce "1.23" (#312).
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
      continue;
    }

    // Operators
    // Any `.` the number branch above did not take is concatenation.
    if (expr.charAt(i) === '.') {
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
      // The word operators are contextual (#332). AND, OR, XOR, IN and LIKE are
      // all binary, so they can only be operators straight after a complete
      // value; anywhere a value is expected the word is an ordinary identifier —
      // a field named `xor` or `like`, or a function call when `(` follows, as
      // in `in(x, "a", "b")` or `like(x, "a%")`. Lexing them as operators
      // unconditionally (#312) broke every expression that read such a field.
      // NOT is the exception: it is a prefix operator, so value position is
      // exactly where it is legitimate, and after a value it is the NOT of
      // `x NOT IN (...)`. It stays a keyword everywhere.
      const valueInProgress =
        prevTok !== undefined &&
        (prevTok.type === 'string' ||
          prevTok.type === 'number' ||
          prevTok.type === 'ident' ||
          prevTok.type === 'field_ref' ||
          (prevTok.type === 'paren' && prevTok.value === ')'));
      if (upper === 'NOT' || (valueInProgress && ['AND', 'OR', 'IN', 'LIKE', 'XOR'].includes(upper))) {
        tokens.push({ type: 'op', value: upper });
      } else {
        tokens.push({ type: 'ident', value: ident });
      }
      continue;
    }

    // Anything else is not part of eval syntax. It used to be skipped without a
    // word, which is how `.5` lost its point; an expression the simulator does
    // not understand should be reported, not evaluated as something else (#312).
    throw new Error(`Unexpected character: ${expr.charAt(i)}`);
  }

  return tokens;
}
