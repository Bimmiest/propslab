/**
 * V8's heap-size flags are process-wide, and when one is set it takes
 * precedence over the per-worker `resourceLimits` in runInWorker.ts. So a
 * `NODE_OPTIONS=--max-old-space-size=8192` in the user's shell (a common
 * enough fix for unrelated tools) silently raised every sandbox worker's heap
 * ceiling to 8GB. The server's own thread holds little, because the engine
 * runs in the workers, so the launcher drops these flags when it re-execs
 * rather than let them defeat the sandbox.
 *
 * Kept apart from `index.ts` so it can be tested without importing the
 * launcher, whose module body re-execs node.
 */

// `--flag=N` and `--flag N`, `-` or `_` separated: the forms node accepts.
const HEAP_SIZE_FLAG = /^--max[-_](?:old[-_]space|semi[-_]space|heap)[-_]size(?:=|$)/;

/** `process.execArgv` minus any heap-size flag (and a separate numeric value). */
export function stripHeapSizeFlags(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  let skipValue = false;
  for (const [i, arg] of execArgv.entries()) {
    if (skipValue) skipValue = false;
    else if (!HEAP_SIZE_FLAG.test(arg)) kept.push(arg);
    else skipValue = !arg.includes('=') && /^\d+$/.test(execArgv[i + 1] ?? '');
  }
  return kept;
}

/** One argument of `NODE_OPTIONS`: its value, and where its text lies in the string. */
interface NodeOption {
  value: string;
  start: number;
  end: number;
}

/**
 * `NODE_OPTIONS` split into arguments the way node splits it
 * (`ParseNodeOptionsEnvVar` in node_options.cc): arguments are separated by
 * spaces — only spaces — outside double quotes; a double quote toggles
 * quoting and is dropped; inside quotes a backslash takes the next
 * character literally. So `"--max-old-space-size=8192"` is the flag itself,
 * which a pattern over the raw text missed.
 */
export function tokenizeNodeOptions(nodeOptions: string): NodeOption[] {
  const options: NodeOption[] = [];
  let current: NodeOption | undefined;
  let quoted = false;
  for (let i = 0; i < nodeOptions.length; i++) {
    let c = nodeOptions.charAt(i);
    const at = i;
    if (c === '\\' && quoted && i + 1 < nodeOptions.length) {
      c = nodeOptions.charAt(++i);
    } else if (c === ' ' && !quoted) {
      current = undefined;
      continue;
    } else if (c === '"') {
      quoted = !quoted;
      // A quote starts an argument even if nothing follows it (`""`).
      current ??= pushOption(options, at);
      current.end = i + 1;
      continue;
    }
    current ??= pushOption(options, at);
    current.value += c;
    current.end = i + 1;
  }
  return options;
}

function pushOption(options: NodeOption[], start: number): NodeOption {
  const option = { value: '', start, end: start };
  options.push(option);
  return option;
}

/**
 * `NODE_OPTIONS` minus any heap-size flag (and a separate numeric value).
 * Each flag is cut out of the string where it stands rather than the string
 * being rebuilt from its arguments, so quoting elsewhere in it (a `--require`
 * path with spaces, say) survives byte for byte; a string with no such flag
 * comes back identical.
 */
export function stripHeapSizeFlagsFromNodeOptions(nodeOptions: string): string {
  const options = tokenizeNodeOptions(nodeOptions);
  const cut: NodeOption[] = [];
  for (const [i, option] of options.entries()) {
    if (!HEAP_SIZE_FLAG.test(option.value)) continue;
    cut.push(option);
    const next = options[i + 1];
    if (!option.value.includes('=') && next !== undefined && /^\d+$/.test(next.value)) cut.push(next);
  }
  let out = nodeOptions;
  for (const { start, end } of cut.toReversed()) out = out.slice(0, start) + out.slice(end);
  return out;
}
