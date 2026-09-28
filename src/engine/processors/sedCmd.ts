import type { SplunkEvent, ConfDirective, DirectiveNoOp, RawMutation, ValidationDiagnostic } from '../types';
import { longestPartialMatch } from '../noOpExplainer';
import { safeRegex, validateRegex, type RegexMatch, type SplunkRegex } from '../../utils/splunkRegex';
import { byClassName } from '../utils/asciiCompare';
import { changeWindow } from '../utils/changeWindow';
import { atDirective } from '../parser/provenance';

interface SedCommand {
  className: string;
  /** The `s///` pattern; absent for `y///`. */
  pattern?: SplunkRegex;
  /** The `s///` replacement, expanded per match. */
  replacement: (match: RegexMatch) => string;
  global: boolean;
  /**
   * Character map for the `y///` transliterate form. When present the command
   * substitutes per character through this table rather than expanding
   * `replacement`, which has no meaning for a transliteration.
   */
  translate?: Map<string, string>;
}

/** A replacement template: literal text, or a group number (0 = whole match). */
type ReplacementPart = string | number;

/**
 * Parse a sed replacement string. The expression parser preserves backslashes
 * verbatim, so this single left-to-right pass resolves the escapes with sed's
 * semantics — not PCRE2's substitution syntax, which Splunk does not use:
 *   - `\1`..`\9`  → that capture group (empty when it did not participate)
 *   - `\0` and a bare `&` → the whole match
 *   - `\<char>`   → the escaped literal, with the backslash dropped (this covers
 *                   an escaped delimiter like `s/b/x\/y/` → `x/y`, plus `\\` → `\`
 *                   and `\&` → a literal ampersand)
 *   - `$` is an ordinary character
 */
function buildReplacement(raw: string): (match: RegexMatch) => string {
  const parts: ReplacementPart[] = [];
  let literal = '';
  const flush = () => {
    if (literal) parts.push(literal);
    literal = '';
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i);
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw.charAt(i + 1);
      if (next >= '0' && next <= '9') {
        flush();
        parts.push(Number(next));
      } else {
        literal += next;
      }
      i++;
      continue;
    }
    if (c === '&') {
      flush();
      parts.push(0);
      continue;
    }
    literal += c;
  }
  flush();
  return (match) => {
    let out = '';
    for (const part of parts) out += typeof part === 'string' ? part : (match[part] ?? '');
    return out;
  };
}

/**
 * A sed command is a verb followed by its delimiter, and the delimiter is any
 * character that is not alphanumeric, `_`, or whitespace.
 *
 * Testing `startsWith('s')` / `startsWith('y')` instead read ordinary prose as
 * a command: `SEDCMD-x = yes` was reported as unsimulated `y///`
 * transliteration, and `SEDCMD-x = something` was parsed as a substitution with
 * `o` for a delimiter — producing a nonsense pattern/replacement split rather
 * than "this is not a sed expression".
 */
const SED_COMMAND_RE = /^([sy])([^\w\s])/;

/** Shared shape for every diagnostic this file raises about one directive. */
function sedWarning(
  dir: ConfDirective | undefined,
  message: string,
): ValidationDiagnostic {
  return {
    level: 'warning',
    message: `SEDCMD-${dir?.className ?? ''}: ${message}`,
    file: 'props.conf',
    ...atDirective(dir),
    directiveKey: dir?.key,
  };
}

/**
 * Resolve the escapes sed recognises inside a `y///` set. The expression parser
 * keeps backslashes verbatim so `s///` can hand them to the regex engine, but a
 * transliteration set is a literal list of characters, so they resolve here.
 */
function unescapeTranslateSet(set: string, delimiter: string): string {
  let out = '';
  for (let i = 0; i < set.length; i++) {
    if (set[i] !== '\\' || i === set.length - 1) {
      out += set[i];
      continue;
    }
    const next = set[++i];
    out +=
      next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next === delimiter ? delimiter : next;
  }
  return out;
}

/**
 * Build the `y/<from>/<to>/` transliterate form: replace every occurrence of
 * each character in `from` with the character at the same position in `to`.
 *
 * Unlike `s///` this is unconditionally global and has no flags — `y/abc/ABC/`
 * rewrites the `abc` inside `abcdef` as well as a standalone one, and leaves
 * `def` alone.
 */
function parseTransliterate(
  fromRaw: string,
  toRaw: string,
  delimiter: string,
  dir?: ConfDirective,
  diagnostics?: ValidationDiagnostic[],
): SedCommand | null {
  const from = [...unescapeTranslateSet(fromRaw, delimiter)];
  const to = [...unescapeTranslateSet(toRaw, delimiter)];

  if (from.length === 0) return null;
  if (from.length !== to.length) {
    // sed itself rejects this outright, so producing a partial transliteration
    // would be inventing behaviour no implementation has.
    diagnostics?.push(
      sedWarning(
        dir,
        `y/// needs both character sets to be the same length (got ${from.length} and ${to.length}), ` +
          'so the directive was ignored.',
      ),
    );
    return null;
  }

  const translate = new Map<string, string>();
  // A character repeated in the source set takes its FIRST mapping, which is
  // what sed does — later duplicates are dead entries rather than overrides.
  from.forEach((ch, i) => {
    if (!translate.has(ch)) translate.set(ch, to[i] ?? ch);
  });

  return {
    className: '',
    replacement: () => '',
    global: true,
    translate,
  };
}

/**
 * Parse and compile one SEDCMD value, pushing a diagnostic for anything that
 * stops it applying. Exported for static lint (the MCP validate tool), which
 * checks every stanza's SEDCMDs whether or not a sample would reach them.
 */
export function parseSedExpression(
  value: string,
  dir?: ConfDirective,
  diagnostics?: ValidationDiagnostic[],
): SedCommand | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const command = SED_COMMAND_RE.exec(trimmed);
  if (!command) {
    diagnostics?.push(
      sedWarning(
        dir,
        `"${trimmed}" is not a sed expression and was ignored. SEDCMD takes ` +
          's/<regex>/<replacement>/<flags> (any non-alphanumeric character may be the delimiter).',
      ),
    );
    return null;
  }

  const [, verb, delimiter] = command;

  const parts: string[] = [];
  let current = '';
  let escaped = false;

  for (let i = 2; i < trimmed.length; i++) {
    if (escaped) {
      current += trimmed[i];
      escaped = false;
      continue;
    }
    if (trimmed[i] === '\\') {
      escaped = true;
      current += '\\';
      continue;
    }
    if (trimmed[i] === delimiter) {
      parts.push(current);
      current = '';
      continue;
    }
    current += trimmed[i];
  }
  if (current) parts.push(current);

  if (parts.length < 2) {
    diagnostics?.push(
      sedWarning(
        dir,
        `"${trimmed}" is missing its closing delimiter "${delimiter}" and was ignored. ` +
          `SEDCMD takes s${delimiter}<regex>${delimiter}<replacement>${delimiter}<flags>.`,
      ),
    );
    return null;
  }

  if (verb === 'y') {
    return parseTransliterate(parts[0] ?? '', parts[1] ?? '', delimiter ?? '/', dir, diagnostics);
  }

  const patternStr = parts[0] ?? '';
  const replacement = buildReplacement(parts[1] ?? '');
  const flags = parts[2] ?? '';
  const isGlobal = flags.includes('g');

  // The s/.../.../N occurrence flag (replace only the Nth match) is not simulated —
  // the engine replaces the first match (or all, with g). Warn so the divergence is visible.
  if (/\d/.test(flags)) {
    diagnostics?.push(
      sedWarning(
        dir,
        `the numeric occurrence flag (s/.../.../N) is not simulated — the preview replaces the ${isGlobal ? 'matches globally' : 'first match'} instead of only the Nth.`,
      ),
    );
  }

  const regex = safeRegex(patternStr);
  if (!regex) {
    // Every other regex-bearing directive already warns here (LINE_BREAKER,
    // BREAK_ONLY_BEFORE, MUST_BREAK_AFTER, EXTRACT, TRANSFORMS). SEDCMD is the
    // one most often used for masking PII, so a silent drop is the most costly
    // place to have it: the preview reads as "the pattern didn't match this
    // sample" when the truth is "the pattern never compiled".
    diagnostics?.push(
      sedWarning(
        dir,
        `the pattern (${patternStr}) does not compile (${validateRegex(patternStr) ?? 'invalid regex'}). ` +
          'The substitution was skipped, so the event is shown unmodified.',
      ),
    );
    return null;
  }

  return {
    className: '',
    pattern: regex,
    replacement,
    global: isGlobal,
  };
}

export function applySedCommands(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
): SplunkEvent[] {
  const sedDirectives = directives
    .filter((d) => d.directiveType === 'SEDCMD')
    .sort(byClassName);

  if (sedDirectives.length === 0) return events;

  const commands: (SedCommand & { directive: ConfDirective })[] = [];
  for (const dir of sedDirectives) {
    const cmd = parseSedExpression(dir.value, dir, diagnostics);
    if (cmd) {
      cmd.className = dir.className ?? '';
      commands.push({ ...cmd, directive: dir });
    }
  }

  if (commands.length === 0) return events;

  return events.map((event) => {
    let raw = event._raw;
    const traces: SplunkEvent['processingTrace'] = [];
    const mutations: RawMutation[] = [];
    // A SEDCMD that leaves _raw byte-for-byte identical is the classic silent
    // no-op: the masking rule ships, the data is not masked, and the preview
    // looks exactly like a working one.
    const noOps: DirectiveNoOp[] = [];

    for (const cmd of commands) {
      const before = raw;
      const table = cmd.translate;
      if (table) {
        let out = '';
        for (const ch of raw) out += table.get(ch) ?? ch;
        raw = out;
      } else if (cmd.pattern) {
        raw = cmd.pattern.replace(raw, cmd.replacement, cmd.global);
      }

      if (raw !== before) {
        // Each command is attributed separately: two SEDCMDs masking two
        // different fields must not collapse into one undifferentiated "masking
        // happened" note.
        mutations.push({
          traceIndex: event.processingTrace.length + traces.length,
          rawBefore: before,
          rawAfter: raw,
        });
        traces.push({
          processor: `SEDCMD-${cmd.className}`,
          phase: 'index-time',
          description: `Applied sed substitution`,
          ...changeWindow(before, raw),
        });
      } else {
        const limitHit = cmd.pattern?.lastError;
        const partial =
          limitHit === undefined && cmd.pattern ? longestPartialMatch(cmd.pattern.source, before) : null;
        noOps.push({
          directive: cmd.directive.key,
          file: 'props.conf',
          line: cmd.directive.line,
          phase: 'index-time',
          reason:
            limitHit !== undefined
              ? { kind: 'regex-limit', error: limitHit }
              : partial
                ? { kind: 'no-match', partialEnd: partial.end, partialPattern: partial.prefix }
                : { kind: 'no-match' },
        });
      }
    }

    return {
      ...event,
      _raw: raw,
      processingTrace: [...event.processingTrace, ...traces],
      rawMutations: [...(event.rawMutations ?? []), ...mutations],
      ...(noOps.length > 0 ? { noOps: [...(event.noOps ?? []), ...noOps] } : {}),
    };
  });
}
