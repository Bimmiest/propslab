import type { editor } from 'monaco-editor';
import {
  getDirectiveInfo,
  getClassBasedDirectiveBase,
  wrongFileCanonical,
  WRONG_FILE_MESSAGE,
} from '../engine/directiveRegistry';
import { isUndocumentedAttribute } from '../engine/directiveSupport';
import { isSplunkBoolLiteral, parseSplunkBool } from '../engine/utils/directiveValues';
import { DIRECTIVE_RE, miscasedCanonical, MISCASED_MESSAGE } from '../engine/parser/confParser';
import { unsupportedSpecifiers } from '../utils/strftime';
import { translatePcreToJs, validateRegex } from '../utils/splunkRegex';

/**
 * One directive as the linter saw it, for the stanza-scoped checks below.
 * `value` is the joined value (continuations resolved), `line` is 1-based.
 */
interface SeenDirective {
  line: number;
  value: string;
}

/** A stanza and the directives defined in it (last definition of a key wins). */
interface SeenStanza {
  name: string;
  directives: Map<string, SeenDirective>;
}

export interface DiagnosticMarker {
  severity: 8 | 4 | 2 | 1; // Error=8, Warning=4, Info=2, Hint=1
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  /** Identifies a marker a quick fix can act on. See MISCASED_MARKER_CODE. */
  code?: string;
}

/**
 * Tags the mis-cased-attribute marker so the code action provider can offer the
 * rename against it, rather than re-deriving which markers are fixable by
 * matching on message text (#89).
 */
export const MISCASED_MARKER_CODE = 'splunk.miscased-attribute';

export function computeDiagnostics(
  model: editor.ITextModel,
  fileType: 'props.conf' | 'transforms.conf'
): DiagnosticMarker[] {
  const markers: DiagnosticMarker[] = [];
  const lineCount = model.getLineCount();
  const seenStanzas = new Set<string>();

  // Stanzas in file order, for the best-practice checks. Directives before any
  // header belong to an implicit [default], matching confParser.
  const stanzas: SeenStanza[] = [];
  let currentStanza: SeenStanza | null = null;
  const stanzaFor = (): SeenStanza => {
    if (!currentStanza) {
      currentStanza = { name: 'default', directives: new Map() };
      stanzas.push(currentStanza);
    }
    return currentStanza;
  };

  // Splunk continues a directive onto the next line when the line ends with a
  // trailing backslash (NOT when the next line begins with whitespace). Only a
  // line that is actually a DIRECTIVE (or an ongoing continuation of one) can
  // start a continuation — a stanza header or a malformed line ending in `\`
  // must not. This mirrors confParser's `lastDirective` gating; without it the
  // line after any backslash-terminated header/garbage line was silently skipped.
  let inDirectiveValue = false;

  for (let i = 1; i <= lineCount; i++) {
    const line = model.getLineContent(i);
    const trimmed = line.trim();
    const endsWithBackslash = endsWithContinuation(line.trimEnd());

    if (inDirectiveValue && trimmed !== '') {
      // Part of the previous directive's value — skip it. It continues the
      // value further only if it too ends with a trailing backslash.
      inDirectiveValue = endsWithBackslash;
      continue;
    }

    // Not a continuation: reset. Only the directive branch below re-arms it.
    inDirectiveValue = false;

    // Skip comments and blank lines. Splunk .conf uses `#` only — `;` is NOT a comment.
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Stanza headers
    if (trimmed.startsWith('[')) {
      if (!trimmed.endsWith(']')) {
        markers.push({
          severity: 8,
          message: 'Missing closing bracket "]" for stanza header',
          startLineNumber: i,
          startColumn: 1,
          endLineNumber: i,
          endColumn: line.length + 1,
        });
        continue;
      }

      const stanzaName = trimmed.slice(1, -1).trim();
      if (seenStanzas.has(stanzaName)) {
        markers.push({
          severity: 4,
          message: `Duplicate stanza "${stanzaName}" — Splunk merges duplicate stanzas key-by-key (a later key overrides the same earlier key; keys only in the earlier stanza are kept)`,
          startLineNumber: i,
          startColumn: 1,
          endLineNumber: i,
          endColumn: line.length + 1,
        });
      }
      seenStanzas.add(stanzaName);
      currentStanza = { name: stanzaName, directives: new Map() };
      stanzas.push(currentStanza);
      continue;
    }

    // Directives. Recognised with the ENGINE's rule (`DIRECTIVE_RE`) rather than
    // a looser `indexOf('=')` test, so the editor and the diagnostics list agree
    // about what counts as a directive. In particular a leading-whitespace line
    // is malformed to Splunk, and used to be skipped here without a marker.
    const eqIdx = line.indexOf('=');
    if (!DIRECTIVE_RE.test(line)) {
      markers.push({
        severity: 8,
        message: `Malformed line — expected "key = value" or a stanza header. ${
          /^\s/.test(line)
            ? 'Directive keys cannot be indented; Splunk continues a value with a trailing backslash, not with leading whitespace.'
            : 'Splunk .conf lines are "key = value", "[stanza]", or a "#" comment.'
        }`,
        startLineNumber: i,
        startColumn: 1,
        endLineNumber: i,
        endColumn: line.length + 1,
      });
      continue;
    }

    // This line is a directive — a trailing backslash now legitimately starts a
    // continuation onto the next line.
    inDirectiveValue = endsWithBackslash;

    const key = line.substring(0, eqIdx).trim();
    // Validate the value Splunk will actually see. A backslash-continued
    // directive's first line is only a FRAGMENT — validating it on its own
    // reported "Invalid regex pattern: \\ at end of pattern" on conf that is
    // valid once joined, painting a hard error on a working LINE_BREAKER.
    const value = endsWithBackslash
      ? joinContinuedValue(model, i, line.substring(eqIdx + 1), lineCount)
      : line.substring(eqIdx + 1).trim();

    // Record for the stanza-scoped checks. Last definition of a key wins, which
    // is Splunk's rule and the one mergeDirectives applies.
    stanzaFor().directives.set(key, { line: i, value });

    // Check if directive is known
    let info = getDirectiveInfo(key, fileType);
    let baseKey = key;

    if (!info) {
      const parsed = getClassBasedDirectiveBase(key);
      if (parsed) {
        info = getDirectiveInfo(parsed.base, fileType);
        baseKey = parsed.base;
      }
    }

    if (!info) {
      // A case-only mismatch is a real attribute written in a casing Splunk
      // ignores, which is a different problem from a typo and has an exact fix.
      // Marked with MISCASED_MARKER_CODE so the quick fix can find it (#89).
      const canonical = miscasedCanonical(key, fileType);
      if (canonical !== undefined) {
        markers.push({
          severity: 4, // Warning — this config is dead on a real indexer.
          code: MISCASED_MARKER_CODE,
          message: MISCASED_MESSAGE(key, canonical),
          startLineNumber: i,
          startColumn: 1,
          endLineNumber: i,
          endColumn: eqIdx + 1,
        });
        continue;
      }

      // A real attribute of the other conf file is not a typo either: Splunk
      // ignores it here, and the fix is to move it. The engine reports the same
      // sentence in the validation panel (#278). A warning, like the mis-cased
      // branch above, because the line is dead on a real indexer. No quick fix:
      // moving a line into another file's stanza is not a safe automatic edit.
      const belongsIn = wrongFileCanonical(key, fileType);
      if (belongsIn !== undefined) {
        markers.push({
          severity: 4,
          message: WRONG_FILE_MESSAGE(key, fileType, belongsIn),
          startLineNumber: i,
          startColumn: 1,
          endLineNumber: i,
          endColumn: eqIdx + 1,
        });
        continue;
      }

      // A valid attribute the registry has not documented yet is not a typo,
      // and telling the user it might be sends them to check spelling that is
      // already correct. The engine warns that the preview ignores it (#178),
      // the same way it does for a documented-but-`ignored` key — so say
      // nothing more here rather than contradicting it.
      if (isUndocumentedAttribute(key)) continue;
      markers.push({
        severity: 2, // Info
        message: `Unknown directive "${key}" — possible typo?`,
        startLineNumber: i,
        startColumn: 1,
        endLineNumber: i,
        endColumn: eqIdx + 1,
      });
      continue;
    }

    // A strftime specifier the simulator does not implement is treated as
    // literal text, so the format quietly fails to match rather than erroring
    // (#90). Informational, not a warning: the config may well be correct for a
    // real indexer — it is this preview that will be wrong.
    // Offsets are into the value, so they only map back to THIS line when the
    // value was not joined from a continuation. Rather than mis-place a marker
    // on a continued format, the whole value is underlined in that case.
    if (info.valueType === 'strftime' && value && !endsWithBackslash) {
      const rawValue = line.substring(eqIdx + 1);
      const valueStartColumn = eqIdx + 2 + (rawValue.length - rawValue.trimStart().length);
      for (const { specifier, index } of unsupportedSpecifiers(value)) {
        markers.push({
          severity: 2, // Info
          message: `${specifier} is not simulated — the preview treats it as literal text, so _time may not resolve here even if a real indexer parses it.`,
          startLineNumber: i,
          startColumn: valueStartColumn + index,
          endLineNumber: i,
          endColumn: valueStartColumn + index + specifier.length,
        });
      }
    }

    // Validate value types
    if (info.valueType === 'regex' && value) {
      const error = validateRegex(value);
      if (error) {
        markers.push({
          severity: 8,
          message: `Invalid regex pattern: ${error}`,
          startLineNumber: i,
          startColumn: eqIdx + 2,
          endLineNumber: i,
          endColumn: line.length + 1,
        });
      } else {
        // The pattern compiles, but its PCRE→JS translation may only
        // approximate Splunk's meaning (e.g. a mid-pattern `(?i)` hoisted to the
        // whole pattern where scoped modifier groups are unavailable). A
        // warning, since the config is fine for a real indexer — it is the
        // preview that may differ.
        for (const warning of translatePcreToJs(value).warnings) {
          markers.push({
            severity: 4,
            message: `Regex approximated in preview: ${warning}`,
            startLineNumber: i,
            startColumn: eqIdx + 2,
            endLineNumber: i,
            endColumn: line.length + 1,
          });
        }
      }
    }

    if (info.valueType === 'boolean' && value) {
      // The engine's own reading, so the editor never flags a spelling the
      // preview honours (t/f, y/n, on/off) or accepts one it does not.
      if (!isSplunkBoolLiteral(value)) {
        markers.push({
          severity: 4,
          message: `Expected boolean value (true/false) for "${baseKey}", got "${value}"`,
          startLineNumber: i,
          startColumn: eqIdx + 2,
          endLineNumber: i,
          endColumn: line.length + 1,
        });
      }
    }

    if (info.valueType === 'number' && value) {
      if (isNaN(Number(value))) {
        markers.push({
          severity: 4,
          message: `Expected numeric value for "${baseKey}", got "${value}"`,
          startLineNumber: i,
          startColumn: eqIdx + 2,
          endLineNumber: i,
          endColumn: line.length + 1,
        });
      }
    }

    if (info.valueType === 'enum' && value && info.enumValues) {
      if (!info.enumValues.includes(value.toLowerCase()) && !info.enumValues.includes(value)) {
        markers.push({
          severity: 4,
          message: `Invalid value "${value}" for "${baseKey}". Valid values: ${info.enumValues.join(', ')}`,
          startLineNumber: i,
          startColumn: eqIdx + 2,
          endLineNumber: i,
          endColumn: line.length + 1,
        });
      }
    }

    // Best practice warnings
    if (baseKey === 'LINE_BREAKER' && value) {
      // Check for a real CAPTURING group — not an escaped `\(` literal and not a
      // non-capturing `(?:…)` / lookaround `(?=…)` group.
      if (!hasCapturingGroup(value)) {
        markers.push({
          severity: 4,
          message: 'LINE_BREAKER regex should contain at least one capturing group () — the captured content defines the break point',
          startLineNumber: i,
          startColumn: eqIdx + 2,
          endLineNumber: i,
          endColumn: line.length + 1,
        });
      }
    }

    if (info.deprecated) {
      markers.push({
        severity: 2,
        message: `"${baseKey}" is deprecated — consider using the recommended alternative`,
        startLineNumber: i,
        startColumn: 1,
        endLineNumber: i,
        endColumn: eqIdx + 1,
      });
    }
  }

  // Best-practice checks, evaluated within each stanza.
  checkBestPractices(stanzas, markers, fileType);

  return markers;
}

/**
 * Splunk continues a directive when its line ends with an ODD number of
 * backslashes; an even count is escaped literal backslashes (a Windows path,
 * say), not a continuation. Mirrors `confParser.endsWithContinuation`.
 */
function endsWithContinuation(value: string): boolean {
  let count = 0;
  for (let i = value.length - 1; i >= 0 && value[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

/**
 * Join a backslash-continued value into the single logical value Splunk parses,
 * so validation sees the whole thing. Drops the continuation backslash and
 * appends the next line verbatim, exactly as `confParser` does.
 */
function joinContinuedValue(
  model: editor.ITextModel,
  startLine: number,
  firstFragment: string,
  lineCount: number,
): string {
  let joined = firstFragment.trimEnd();
  for (let line = startLine + 1; line <= lineCount && endsWithContinuation(joined); line++) {
    joined = joined.slice(0, -1) + model.getLineContent(line).trimEnd();
  }
  return joined.trim();
}

/**
 * Returns true if the regex contains at least one *capturing* group. Ignores
 * escaped literal parens (`\(`) and non-capturing / lookaround groups, which a
 * naive `includes('(')` check would wrongly accept.
 *
 * NAMED groups — `(?<name>…)` and Splunk's Python-style `(?P<name>…)` — are
 * capturing, and LINE_BREAKER breaks on the first capturing group whether or not
 * it is named. Treating every `(?` as non-capturing warned that
 * `LINE_BREAKER = (?<br>[\r\n]+)` had no capturing group, on config that works.
 * The lookbehind forms `(?<=…)` and `(?<!…)` start the same way and are not.
 */
function hasCapturingGroup(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (c !== '(') continue;
    if (pattern[i + 1] !== '?') return true; // plain ( … )
    // `(?P<name>` — Python-style named group.
    if (pattern[i + 2] === 'P' && pattern[i + 3] === '<') return true;
    // `(?<name>` — named group, but NOT `(?<=` / `(?<!` lookbehind.
    if (pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!') return true;
  }
  return false;
}

/**
 * Best-practice pairings, checked WITHIN each stanza.
 *
 * These used to run as `/^LINE_BREAKER\s*=/m` and friends over the whole
 * document, which is not what either rule means. Splunk resolves directives per
 * stanza, so a `LINE_BREAKER` in one sourcetype was silenced by a
 * `SHOULD_LINEMERGE = false` in an entirely different one — a false negative on
 * exactly the "config that ships dead" class this linter exists to catch. The
 * document-wide search also anchored the marker at the FIRST matching line in
 * the file, so with several stanzas the warning could land on a line that was
 * not the offending one.
 */
function checkBestPractices(
  stanzas: SeenStanza[],
  markers: DiagnosticMarker[],
  fileType: 'props.conf' | 'transforms.conf'
): void {
  // Both rules are about props.conf directives; transforms.conf has no
  // LINE_BREAKER or TIME_PREFIX to reason about.
  if (fileType !== 'props.conf') return;

  const at = (directive: SeenDirective, message: string): DiagnosticMarker => ({
    severity: 4,
    message,
    startLineNumber: directive.line,
    startColumn: 1,
    endLineNumber: directive.line,
    endColumn: 1,
  });

  for (const stanza of stanzas) {
    const lineBreaker = stanza.directives.get('LINE_BREAKER');
    const shouldLinemerge = stanza.directives.get('SHOULD_LINEMERGE');
    const timePrefix = stanza.directives.get('TIME_PREFIX');
    const timeFormat = stanza.directives.get('TIME_FORMAT');

    // Inspect the VALUE, not mere presence: `SHOULD_LINEMERGE = true` is the
    // wrong setting alongside a custom LINE_BREAKER, yet mere presence used to
    // suppress the very warning that asks for `= false`.
    // Read as the engine reads it: a non-boolean explicit value counts as off.
    const linemergeDisabled = shouldLinemerge ? !parseSplunkBool(shouldLinemerge.value, false) : false;

    if (lineBreaker && !linemergeDisabled) {
      markers.push(
        at(lineBreaker, 'Best practice: Set SHOULD_LINEMERGE = false when using a custom LINE_BREAKER'),
      );
    }

    if (timePrefix && !timeFormat) {
      markers.push(
        at(timePrefix, 'Best practice: Set TIME_FORMAT when using TIME_PREFIX for reliable timestamp extraction'),
      );
    }
  }
}
