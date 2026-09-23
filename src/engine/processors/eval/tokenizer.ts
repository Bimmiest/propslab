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
 * for an in-bounds index instead of `string | undefined`. The two lookaheads at
 * `i + 1` are the only reads that can run off the end, and both compare the
 * result against a literal — where charAt's `''` is the answer we want anyway.
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
