/**
 * Parser for Splunk .conf INI-style configuration files.
 *
 * Takes raw text from a props.conf or transforms.conf file and returns a
 * `ParsedConf` object containing an ordered list of stanzas (with their
 * directives) and any parse errors encountered along the way.
 *
 * The input may also be an ordered list of LAYERS (`$APP/default/props.conf`
 * then `$APP/local/props.conf`, lowest precedence first) rather than one flat
 * file. Splunk merges those layers per attribute, not per file, so they are
 * merged here — at parse time — rather than left to each caller: the layer a
 * directive came from is destroyed the moment the text is parsed, and no
 * consumer can recover it afterwards. See `parseConf`.
 */

import type {
  ConfDirective,
  ConfInput,
  ConfStanza,
  OverriddenDirective,
  ParsedConf,
  ValidationDiagnostic,
} from '../types';
import { getCanonicalDirectiveKey } from '../directiveRegistry';
import { classifyStanza } from '../stanzaRegistry';

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/** Matches a stanza header: `[stanza-name]`. Exported for the editor's linter, like DIRECTIVE_RE. */
export const STANZA_RE = /^\[(.+)\]\s*$/;

/**
 * Matches a key/value directive.
 *
 * The key may not start with whitespace or `[`: a `[` line that is not a
 * well-formed header (`[a=b]\`, `[a] x = y`) is a broken header, not a
 * directive keyed `[a`. The `=` may be surrounded by
 * optional whitespace.  The value extends to the end of the line (trailing
 * whitespace is preserved because Splunk does the same).
 *
 * Exported so the Monaco linter can decide what a directive is with the same
 * rule the engine uses. Deciding separately (`line.indexOf('=') > 0`) meant an
 * indented `  KV_MODE = json` linted clean in the editor while the diagnostics
 * list reported it as a malformed line — two validators, side by side in the
 * UI, disagreeing about the same line.
 */
export const DIRECTIVE_RE = /^([^\s=[][^=]*?)\s*=\s*(.*)$/;

/** Matches a comment line. Splunk .conf uses `#` only — `;` is not a comment. */
const COMMENT_RE = /^#/;

/** Matches a blank / whitespace-only line. */
const BLANK_RE = /^\s*$/;

// Splunk uses trailing backslash for line continuation (not leading whitespace).
// A line continues only when it ends with an ODD number of backslashes — an even
// count is escaped literal backslashes (e.g. a Windows path "C:\\dir\\"), not a
// continuation marker.
function endsWithContinuation(value: string): boolean {
  let count = 0;
  for (let i = value.length - 1; i >= 0 && value[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

// ---------------------------------------------------------------------------
// Class-based directive detection
// ---------------------------------------------------------------------------

/**
 * Directive prefixes that use the `PREFIX-<className>` convention in
 * props.conf / transforms.conf.
 */
const CLASS_DIRECTIVE_PREFIXES = [
  'EXTRACT',
  'REPORT',
  'LOOKUP',
  'FIELDALIAS',
  'EVAL',
  'SEDCMD',
  'TRANSFORMS',
  // Class-based, like the registry says: without it `RULESET-x` would parse as
  // a bare key named `RULESET-x`, with no class, no support lookup, and no way
  // for the transforms stage to find it.
  'RULESET',
  'RULESET_DESC',
] as const;

/**
 * Given a raw directive key like `EXTRACT-myfield`, split it into the
 * directive type (`EXTRACT`) and the class name (`myfield`).  If the key does
 * not match any known class-based prefix it returns the full key as the
 * directive type with no class name.
 *
 * The prefix comparison is case-SENSITIVE. Splunk attribute names are, so
 * `extract-f` is not `EXTRACT-f` — it is an unknown attribute a real indexer
 * silently ignores. Matching it case-insensitively made the simulator extract
 * fields from config that ships dead, and (because the key then carried a
 * `className`) skipped the very mis-case check that exists to catch this.
 * `miscasedPrefix` carries the canonical spelling so the caller can say so.
 */
function parseDirectiveKey(key: string): {
  directiveType: string;
  className?: string;
  miscasedPrefix?: string;
} {
  for (const prefix of CLASS_DIRECTIVE_PREFIXES) {
    if (key.length > prefix.length + 1 && key[prefix.length] === '-') {
      const candidatePrefix = key.slice(0, prefix.length);
      if (candidatePrefix === prefix) {
        return {
          directiveType: prefix,
          className: key.slice(prefix.length + 1),
        };
      }
      if (candidatePrefix.toUpperCase() === prefix) {
        return { directiveType: key, miscasedPrefix: prefix };
      }
    }
  }

  return { directiveType: key };
}

/**
 * The canonical spelling of a key that differs from a real attribute only by
 * case, or undefined when the key is correct, unknown, or a properly-cased
 * class directive.
 *
 * Covers both forms of the same Splunk footgun: a plain attribute (`kv_mode`
 * for `KV_MODE`) and a class prefix (`extract-f` for `EXTRACT-f`), the second
 * being the harder one to spot by eye. Exported because the editor's linter and
 * its quick fix answer this question too, and three implementations of
 * "is this a case typo" would be three chances to disagree.
 */
export function miscasedCanonical(rawKey: string, file: 'props.conf' | 'transforms.conf'): string | undefined {
  const { className, miscasedPrefix } = parseDirectiveKey(rawKey);
  if (miscasedPrefix !== undefined) {
    return `${miscasedPrefix}${rawKey.slice(miscasedPrefix.length)}`;
  }
  // A correctly-cased class directive carries a className and is not a typo.
  if (className !== undefined) return undefined;

  const canonical = getCanonicalDirectiveKey(rawKey, file);
  return canonical !== undefined && canonical !== rawKey ? canonical : undefined;
}

/** Shared wording, so the engine diagnostic and the editor marker read alike. */
export const MISCASED_MESSAGE = (rawKey: string, canonical: string): string =>
  `"${rawKey}" is ignored — attribute names are case-sensitive. Did you mean "${canonical}"?`;

export const MISCASED_SUGGESTION = (rawKey: string, canonical: string): string =>
  `Change "${rawKey}" to "${canonical}".`;

// ---------------------------------------------------------------------------
// Stanza classification helpers
// ---------------------------------------------------------------------------

/**
 * The `type` and pattern fields of a stanza, read from the one classifier the
 * editor's hover and the dictionary use (`stanzaRegistry.classifyStanza`), so
 * the engine and the editor cannot disagree about what a header is.
 */
function stanzaTypeFields(name: string): Pick<ConfStanza, 'type' | 'sourcePattern' | 'hostPattern'> {
  const { kind, pattern } = classifyStanza(name);
  switch (kind.id) {
    case 'source':
      return { type: 'source', sourcePattern: pattern ?? '' };
    case 'host':
      return { type: 'host', hostPattern: pattern ?? '' };
    case 'default':
      return { type: 'default' };
    case 'sourcetype':
      return { type: 'sourcetype' };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Splunk `.conf` into a structured representation.
 *
 * Accepts either the text of a single flat file, or an ordered list of layers
 * (lowest precedence first) that are merged the way Splunk merges
 * `default/` and `local/`:
 *
 * ```ts
 * parseConf([{ layer: 'default', text: defaultText },
 *            { layer: 'local',   text: localText }], 'props.conf')
 * ```
 *
 * Merging is per *attribute* within a stanza, not per file: a `local` stanza
 * replaces only the attributes it names, and the rest of the `default` stanza
 * survives. That falls out of concatenating each layer's directives in
 * precedence order, because within a stanza Splunk already resolves a repeated
 * key last-definition-wins (`mergeDirectives`).
 *
 * What layered input adds to the result is provenance: every directive carries
 * the `layer` it came from, the winner of a contested key carries `overrides`,
 * and each loser carries `overriddenBy` — the two halves of what
 * `btool … --debug` prints. Stanzas likewise carry the layers that define them.
 *
 * Given a plain string the output is exactly what it has always been, with no
 * provenance fields; given one layer the merge is a no-op, so adopting the
 * layered form cannot change how a config resolves.
 *
 * @param input    - Full text of the file, or layers lowest-precedence-first.
 * @param fileName - Which file is being parsed (used in diagnostic messages).
 * @returns A `ParsedConf` with the merged stanzas and any errors.
 */
export function parseConf(input: ConfInput, fileName: 'props.conf' | 'transforms.conf'): ParsedConf {
  if (typeof input === 'string') {
    const { stanzas, errors } = parseLayer(input, fileName);
    return { stanzas: mergeDuplicateStanzas(stanzas), errors };
  }

  // Appended one by one: spreading into push() passes every element as an
  // argument, and a layer of a few hundred thousand one-line stanzas or
  // malformed lines overflows the stack.
  const stanzas: ConfStanza[] = [];
  const errors: ValidationDiagnostic[] = [];
  for (const { layer, text } of input) {
    const parsed = parseLayer(text, fileName, layer);
    for (const stanza of parsed.stanzas) stanzas.push(stanza);
    for (const error of parsed.errors) errors.push(error);
  }

  const merged = mergeDuplicateStanzas(stanzas);
  for (const stanza of merged) annotateOverrides(stanza);
  return { stanzas: merged, errors };
}

/**
 * The directive the next line may continue, and its value so far as one part
 * per physical line. The parts are joined once, when the value ends: appending
 * each line to the whole value re-copied it every time, which is quadratic in
 * its length.
 */
function createContinuation() {
  let directive: ConfDirective | null = null;
  let parts: string[] = [];

  /** Settle the value: no later line can continue it. */
  const end = (): void => {
    if (directive && parts.length > 1) directive.value = parts.join('');
    directive = null;
    parts = [];
  };

  return {
    start(next: ConfDirective): void {
      directive = next;
      parts = [next.value];
    },
    /**
     * Append `line` to the value if the value continues onto it, and say
     * whether it did; otherwise the value is over.
     *
     * Only the last part is inspected. Every earlier part gave up its final
     * backslash to the continuation it made, leaving an even run, so the
     * parity of the whole value's trailing backslashes is the last part's.
     */
    take(line: string): boolean {
      if (!directive) return false;
      const last = parts.length - 1;
      const tail = parts[last] ?? '';
      if (!endsWithContinuation(tail)) {
        end();
        return false;
      }
      // Drop the continuation backslash and append the next line verbatim — Splunk
      // preserves the continuation line's leading whitespace (no trimStart). A
      // blank line appends nothing, so the continuation simply ends there.
      parts[last] = tail.slice(0, -1);
      parts.push(line);
      return true;
    },
    end,
  };
}

/**
 * Parse one conf file. `layer`, when given, is stamped onto every stanza,
 * directive and diagnostic produced from this text, because once the layers are
 * concatenated a line number alone no longer says which file it is in.
 */
function parseLayer(text: string, fileName: 'props.conf' | 'transforms.conf', layer?: string): ParsedConf {
  const lines = text.split(/\r?\n/);
  const stanzas: ConfStanza[] = [];
  const errors: ValidationDiagnostic[] = [];
  const from: { layer?: string } = layer === undefined ? {} : { layer };

  // The "current" stanza being accumulated.  Lines that appear before any
  // explicit stanza header are implicitly in a virtual [default] stanza.
  let currentStanza: ConfStanza | null = null;

  const continuation = createContinuation();

  /**
   * Flush the current stanza into the results array and reset tracking state.
   */
  function flushStanza(endLine: number): void {
    if (currentStanza) {
      currentStanza.lineRange.end = endLine;
      stanzas.push(currentStanza);
    }
  }

  for (const [i, line] of lines.entries()) {
    const lineNumber = i + 1; // 1-based

    // --- Continuation lines (Splunk: previous directive value ends with a single \) ---
    // Checked before anything else: the line after a continuation belongs to the
    // value whatever it looks like, which is also how the editor's linter reads
    // it. Classifying the line first skipped a `#` line and appended the NEXT
    // directive instead, and left a value followed by a blank line with its
    // backslash still on.
    if (continuation.take(line)) continue;

    // --- Comments ---
    if (COMMENT_RE.test(line)) {
      continue;
    }

    // --- Blank lines ---
    if (BLANK_RE.test(line)) {
      continue;
    }

    // --- Stanza headers ---
    const stanzaMatch = STANZA_RE.exec(line);
    if (stanzaMatch) {
      // Flush the previous stanza (end on the line before this header).
      flushStanza(lineNumber - 1);

      const rawName = (stanzaMatch[1] ?? '').trim();
      const classification = stanzaTypeFields(rawName);

      currentStanza = {
        name: rawName,
        ...classification,
        directives: [],
        lineRange: { start: lineNumber, end: lineNumber },
        ...from,
      };
      continue;
    }

    // --- Directives (key = value) ---
    const directiveMatch = DIRECTIVE_RE.exec(line);
    if (directiveMatch) {
      const rawKey = (directiveMatch[1] ?? '').trim();
      const rawValue = directiveMatch[2] ?? '';

      const { directiveType, className } = parseDirectiveKey(rawKey);

      // Splunk attribute names are case-sensitive, so a mis-cased name -- whether
      // a plain attribute (`kv_mode`) or a class prefix (`extract-f`) -- is
      // silently ignored and the default applies. `miscasedCanonical` decides
      // both cases; the editor's linter calls the same function, so the two
      // validators cannot drift on what counts as a case typo.
      const canonical = miscasedCanonical(rawKey, fileName);
      if (canonical !== undefined) {
        errors.push({
          level: 'warning',
          message: MISCASED_MESSAGE(rawKey, canonical),
          file: fileName,
          ...from,
          line: lineNumber,
          directiveKey: rawKey,
          suggestion: MISCASED_SUGGESTION(rawKey, canonical),
        });
      }

      const directive: ConfDirective = {
        key: rawKey,
        value: rawValue,
        line: lineNumber,
        directiveType,
        ...(className !== undefined ? { className } : {}),
        ...from,
      };

      // If no stanza has been opened yet, create an implicit [default].
      if (!currentStanza) {
        currentStanza = {
          name: 'default',
          type: 'default',
          directives: [],
          lineRange: { start: lineNumber, end: lineNumber },
          ...from,
        };
      }

      currentStanza.directives.push(directive);
      continuation.start(directive);
      continue;
    }

    // --- Malformed line ---
    // If we reach here the line is not a comment, blank, stanza header,
    // directive, or valid continuation.
    errors.push({
      level: 'error',
      message: `Malformed line: "${line.length > 80 ? line.slice(0, 80) + '...' : line}"`,
      file: fileName,
      ...from,
      line: lineNumber,
    });
  }

  // Flush the last directive and stanza.
  continuation.end();
  flushStanza(lines.length);

  return { stanzas, errors };
}

/**
 * Splunk treats repeated stanzas with the same name in one file as a single
 * stanza (Admin manual, "How app configuration files work"), and treats a stanza
 * appearing in both `default/` and `local/` the same way. Concatenate their
 * directives in order so later definitions win: within-stanza last-wins is
 * applied downstream (`mergeDirectives` for props; the transform readers take the
 * last REGEX/FORMAT/INGEST_EVAL for transforms).
 *
 * Because layers arrive lowest-precedence-first, that single rule resolves both a
 * repeat within one file and a `local` override of a `default` attribute — which
 * is how Splunk resolves them too, and why layered input needs no separate merge
 * pass that could drift from the flat-file behaviour.
 */
function mergeDuplicateStanzas(stanzas: ConfStanza[]): ConfStanza[] {
  const byKey = new Map<string, ConfStanza>();
  const order: ConfStanza[] = [];
  for (const stanza of stanzas) {
    const key = `${stanza.type} ${stanza.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      const clone: ConfStanza = {
        ...stanza,
        directives: [...stanza.directives],
        lineRange: { ...stanza.lineRange },
        ...(stanza.layer !== undefined
          ? { layers: [{ layer: stanza.layer, lineRange: { ...stanza.lineRange } }] }
          : {}),
      };
      byKey.set(key, clone);
      order.push(clone);
      continue;
    }

    // One by one, as in parseConf: a spread of a huge stanza overflows the stack.
    for (const directive of stanza.directives) existing.directives.push(directive);

    if (stanza.layer === undefined || existing.layers === undefined) {
      existing.lineRange.end = Math.max(existing.lineRange.end, stanza.lineRange.end);
      continue;
    }

    // Layered: the layers are parsed in order, so this stanza either repeats
    // within the layer already recorded last, or opens a higher one. Line ranges
    // from different files are never combined — that would invent a range that
    // exists in neither.
    const last = existing.layers.at(-1);
    if (last !== undefined && last.layer === stanza.layer) {
      last.lineRange.end = Math.max(last.lineRange.end, stanza.lineRange.end);
    } else {
      existing.layers.push({ layer: stanza.layer, lineRange: { ...stanza.lineRange } });
      existing.layer = stanza.layer;
    }
    // `lineRange`/`layer` track the highest-precedence definition: the file an
    // engineer editing this stanza would open.
    const newest = existing.layers.at(-1);
    if (newest !== undefined) existing.lineRange = { ...newest.lineRange };
  }
  return order;
}

/**
 * Record, for every key defined more than once in a stanza, which definition won
 * and which ones it beat.
 *
 * The winner is the last one — the same rule `mergeDirectives` and the transform
 * readers apply, restated here only to describe it, never to change it. The
 * shadowed definitions stay in `directives` exactly as before, so resolution is
 * unaffected; they simply now say so about themselves.
 */
function annotateOverrides(stanza: ConfStanza): void {
  const byKey = new Map<string, ConfDirective[]>();
  for (const directive of stanza.directives) {
    // Keys are compared case-SENSITIVELY: Splunk ignores a mis-cased attribute
    // rather than letting it take effect, so `kv_mode` does not shadow `KV_MODE`.
    const existing = byKey.get(directive.key);
    if (existing) existing.push(directive);
    else byKey.set(directive.key, [directive]);
  }

  for (const definitions of byKey.values()) {
    const winner = definitions.at(-1);
    if (definitions.length < 2 || winner === undefined) continue;
    const shadowed = definitions.slice(0, -1);
    // Nearest first, so `overrides[0]` is what would apply if the winner went.
    winner.overrides = shadowed.map(directiveRef).reverse();
    const winnerRef = directiveRef(winner);
    for (const directive of shadowed) directive.overriddenBy = winnerRef;
  }
}

/**
 * `layer` is always set here: overrides are only annotated for layered input,
 * which stamps every directive it parses.
 */
function directiveRef(directive: ConfDirective): OverriddenDirective {
  return { layer: directive.layer ?? '', line: directive.line, value: directive.value };
}
