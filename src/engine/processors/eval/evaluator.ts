// The eval tree walker: evaluates a parsed expression against one event. It
// resolves field references, applies the operators, and dispatches calls,
// evaluating the branching functions lazily and handing everything else to the
// builtins.

import type { SplunkEvent } from '../../types';
import { getMetadataField } from '../../utils/metadataFields';
import { getField as getOwnField } from '../../utils/fieldBag';
import { type EvalValue, addOrConcat, arith, compare, numArg, toBool, toStr } from './values';
import { type Node, parseExpression } from './parser';
import { type EvalCtx, evalBuiltin } from './builtins';

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

export function evalNode(node: Node, ctx: EvalCtx): EvalValue {
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
      // settles the result. All three operators yield a boolean. XOR has no
      // short circuit: its answer always depends on both sides (#312).
      const left = evalNode(node.left, ctx);
      if (node.op === 'XOR') return toBool(left) !== toBool(evalNode(node.right, ctx));
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

export function evaluateExpression(
  expr: string,
  event: SplunkEvent,
  onStubWarning?: (fn: string) => void,
  now: number = Date.now(),
  onRegexError?: (fn: string, pattern: string) => void,
): EvalValue {
  return evalNode(parseExpression(expr), { event, now, onStubWarning, onRegexError });
}
