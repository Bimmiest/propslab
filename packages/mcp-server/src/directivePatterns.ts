/**
 * The regexes a directive runs, read the way the engine reads them. One
 * answer for both of the server's static regex checks — validate's compile
 * lint (regexLint.ts) and a timeout's suspect list (suspects.ts) — which used
 * to disagree: the suspect list took the whole value, so an `EXTRACT … in
 * <field>` carried its suffix and a SEDCMD its whole sed expression, and
 * neither looked inside an eval expression at all (#517).
 *
 * - EXTRACT: the pattern before any ` in <field>` (`parseExtractValue`).
 * - SEDCMD: an `s///` expression's regex (`sedPattern`); `y///` has none.
 * - Eval expressions — `EVAL-*`, `INGEST_EVAL` (each assignment), and
 *   `STOP_PROCESSING_IF`: every literal regex passed to `match()`,
 *   `replace()` or `mvfind()`. A regex built at run time from a field is not
 *   knowable here, and `like()` builds its own from a LIKE pattern.
 * - Anything else the registry types `regex`: the trimmed value.
 *
 * `[source::…]` and `[host::…]` stanza patterns are regexes too, but not
 * directives' (stanzaMatcher.ts). Validate reports one that will not compile
 * through the engine's conf lint (configLint.ts). The suspect list leaves them
 * out: each is matched against a source or host name rather than event text,
 * and under Splunk's default match limits.
 */
import { getDirectiveInfo } from '../../../src/engine/directiveRegistry';
import { parseExtractValue } from '../../../src/engine/processors/fieldExtractor';
import { sedPattern } from '../../../src/engine/processors/sedCmd';
import { parseExpression, type Node } from '../../../src/engine/processors/eval/parser';
import { ingestEvalTrees } from '../../../src/engine/transforms/ingestEval';
import type { ConfDirective } from '../../../src/engine/types';

export interface DirectivePattern {
  pattern: string;
  /** A regex inside an eval expression: the function it is passed to, e.g. `match`. */
  fn?: string;
}

/** Eval functions whose second argument is compiled as a regex. */
const REGEX_FUNCTIONS = new Set(['match', 'replace', 'mvfind']);

/** Children of an eval AST node, in source order. */
function children(node: Node): Node[] {
  switch (node.kind) {
    case 'lit':
    case 'field':
      return [];
    case 'call':
      return node.args;
    case 'arith':
    case 'concat':
    case 'compare':
    case 'logical':
      return [node.left, node.right];
    case 'not':
    case 'neg':
      return [node.operand];
    case 'in':
      return [node.value, ...node.list];
  }
}

function collectEvalRegexes(node: Node, out: DirectivePattern[]): void {
  if (node.kind === 'call') {
    const fn = node.name.toLowerCase();
    const arg = node.args[1];
    if (REGEX_FUNCTIONS.has(fn) && arg?.kind === 'lit' && typeof arg.value === 'string') {
      out.push({ pattern: arg.value, fn });
    }
  }
  // The parser caps nesting at 50 levels, so this recursion is bounded.
  for (const child of children(node)) collectEvalRegexes(child, out);
}

/** The literal regexes the given eval trees pass to regex functions. */
function evalRegexes(trees: Node[]): DirectivePattern[] {
  const out: DirectivePattern[] = [];
  for (const tree of trees) collectEvalRegexes(tree, out);
  return out;
}

/** An eval expression's tree, or none: an expression that does not parse runs no regex. */
function parsedTree(expression: string): Node[] {
  try {
    return [parseExpression(expression)];
  } catch {
    // The engine's own lint reports the parse error.
    return [];
  }
}

/** The regexes `dir` runs, in the order they appear in its value; none for a directive that runs none. */
export function directivePatterns(dir: ConfDirective, file: 'props.conf' | 'transforms.conf'): DirectivePattern[] {
  if (!dir.value.trim()) return [];
  const baseKey = dir.className ? dir.directiveType : dir.key;
  // SEDCMD's value embeds its regex in sed syntax rather than being typed
  // `regex` in the registry; it executes against `_raw` all the same.
  if (baseKey === 'SEDCMD') {
    const pattern = sedPattern(dir.value);
    return pattern === null ? [] : [{ pattern }];
  }
  const valueType = getDirectiveInfo(baseKey, file)?.valueType;
  if (valueType === 'eval') {
    // INGEST_EVAL through the engine's own compile, assignment by assignment.
    return evalRegexes(baseKey === 'INGEST_EVAL' ? ingestEvalTrees(dir) : parsedTree(dir.value.trim()));
  }
  if (valueType !== 'regex') return [];
  const pattern = baseKey === 'EXTRACT' ? parseExtractValue(dir.value).pattern : dir.value.trim();
  return [{ pattern }];
}
