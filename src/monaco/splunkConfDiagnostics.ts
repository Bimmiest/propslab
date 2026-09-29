import type { editor } from 'monaco-editor';
import {
  getDirectiveInfo,
  getClassBasedDirectiveBase,
  wrongFileCanonical,
  WRONG_FILE_MESSAGE,
} from '../engine/directiveRegistry';
import { isUndocumentedAttribute } from '../engine/directiveSupport';
import {
  isDisallowedNegative,
  isEnumMember,
  isIntegerLiteral,
  isSplunkBoolLiteral,
  parseSplunkBool,
  regexProblem,
} from '../engine/utils/directiveValues';
import { DIRECTIVE_RE, STANZA_RE, miscasedCanonical, MISCASED_MESSAGE } from '../engine/parser/confParser';
import { unsupportedSpecifiers } from '../utils/strftime';

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
 * matching on message text.
 */
export const MISCASED_MARKER_CODE = 'splunk.miscased-attribute';

type ConfFileType = 'props.conf' | 'transforms.conf';
type DirectiveInfo = NonNullable<ReturnType<typeof getDirectiveInfo>>;

/** A marker on one line, from `startColumn` to (exclusive) `endColumn`. */
function lineMarker(
  line: number,
  severity: DiagnosticMarker['severity'],
  message: string,
  startColumn: number,
  endColumn: number,
): DiagnosticMarker {
  return { severity, message, startLineNumber: line, startColumn, endLineNumber: line, endColumn };
}

/**
 * Check a stanza header line. Returns the stanza's name, or null when the
 * header is malformed (and marked).
 */
function checkStanzaHeader(
  line: string,
  i: number,
  seenStanzas: Set<string>,
  markers: DiagnosticMarker[],
): string | null {
  const trimmed = line.trim();
  if (!STANZA_RE.test(line)) {
    markers.push(lineMarker(
      i,
      8,
      trimmed.endsWith(']')
        ? 'Empty stanza header — expected "[name]"'
        : 'Missing closing bracket "]" for stanza header',
      1,
      line.length + 1,
    ));
    return null;
  }

  const stanzaName = trimmed.slice(1, -1).trim();
  if (seenStanzas.has(stanzaName)) {
    markers.push(lineMarker(
      i,
      4,
      `Duplicate stanza "${stanzaName}" — Splunk merges duplicate stanzas key-by-key (a later key overrides the same earlier key; keys only in the earlier stanza are kept)`,
      1,
      line.length + 1,
    ));
  }
  seenStanzas.add(stanzaName);
  return stanzaName;
}

function malformedLineMarker(line: string, i: number): DiagnosticMarker {
  return lineMarker(
    i,
    8,
    `Malformed line — expected "key = value" or a stanza header. ${
      /^\s/.test(line)
        ? 'Directives, headers and comments cannot be indented; Splunk continues a value with a trailing backslash, not with leading whitespace.'
        : 'Splunk .conf lines are "key = value", "[stanza]", or a "#" comment.'
    }`,
    1,
    line.length + 1,
  );
}

/** The registry entry for `key`, looking through a class-based key to its base. */
function resolveDirectiveInfo(key: string, fileType: ConfFileType): { info: DirectiveInfo | undefined; baseKey: string } {
  const info = getDirectiveInfo(key, fileType);
  if (info) return { info, baseKey: key };
  const parsed = getClassBasedDirectiveBase(key);
  if (!parsed) return { info: undefined, baseKey: key };
  return { info: getDirectiveInfo(parsed.base, fileType), baseKey: parsed.base };
}

/** The marker for a key the registry does not know, if it deserves one. */
function unknownDirectiveMarker(key: string, fileType: ConfFileType, i: number, eqIdx: number): DiagnosticMarker | null {
  // A case-only mismatch is a real attribute written in a casing Splunk
  // ignores, which is a different problem from a typo and has an exact fix.
  // Marked with MISCASED_MARKER_CODE so the quick fix can find it.
  const canonical = miscasedCanonical(key, fileType);
  if (canonical !== undefined) {
    // Warning — this config is dead on a real indexer.
    return { ...lineMarker(i, 4, MISCASED_MESSAGE(key, canonical), 1, eqIdx + 1), code: MISCASED_MARKER_CODE };
  }

  // A real attribute of the other conf file is not a typo either: Splunk
  // ignores it here, and the fix is to move it. The engine reports the same
  // sentence in the validation panel. A warning, like the mis-cased
  // branch above, because the line is dead on a real indexer. No quick fix:
  // moving a line into another file's stanza is not a safe automatic edit.
  const belongsIn = wrongFileCanonical(key, fileType);
  if (belongsIn !== undefined) {
    return lineMarker(i, 4, WRONG_FILE_MESSAGE(key, fileType, belongsIn), 1, eqIdx + 1);
  }

  // A valid attribute the registry has not documented yet is not a typo,
  // and telling the user it might be sends them to check spelling that is
  // already correct. The engine warns that the preview ignores it,
  // the same way it does for a documented-but-`ignored` key — so say
  // nothing more here rather than contradicting it.
  if (isUndocumentedAttribute(key)) return null;
  return lineMarker(i, 2, `Unknown directive "${key}" — possible typo?`, 1, eqIdx + 1);
}

/** One directive line, as the value checks read it. */
interface DirectiveLine {
  /** 1-based line number. */
  i: number;
  line: string;
  eqIdx: number;
  baseKey: string;
  /** The joined value (continuations resolved). */
  value: string;
  /** Whether the value continues onto later lines. */
  continued: boolean;
}

/**
 * A strftime specifier the simulator does not implement is treated as
 * literal text, so the format quietly fails to match rather than erroring.
 * Informational, not a warning: the config may well be correct for a
 * real indexer — it is this preview that will be wrong.
 * Offsets are into the value, so they only map back to THIS line when the
 * value was not joined from a continuation. Rather than mis-place a marker
 * on a continued format, the whole value is underlined in that case.
 */
function checkStrftime(d: DirectiveLine, markers: DiagnosticMarker[]): void {
  const rawValue = d.line.substring(d.eqIdx + 1);
  const valueStartColumn = d.eqIdx + 2 + (rawValue.length - rawValue.trimStart().length);
  for (const { specifier, index } of unsupportedSpecifiers(d.value)) {
    markers.push(lineMarker(
      d.i,
      2,
      `${specifier} is not simulated — the preview treats it as literal text, so _time may not resolve here even if a real indexer parses it.`,
      valueStartColumn + index,
      valueStartColumn + index + specifier.length,
    ));
  }
}

/** Why `value` is not a valid value of `info`'s type, as a marker severity and message, or null. */
function valueTypeProblem(info: DirectiveInfo, baseKey: string, value: string): [8 | 4, string] | null {
  if (info.valueType === 'regex') {
    const error = regexProblem(value);
    return error ? [8, `Invalid regex pattern: ${error}`] : null;
  }
  // The engine's own reading, so the editor never flags a spelling the
  // preview honours (t/f, y/n, on/off) or accepts one it does not.
  if (info.valueType === 'boolean' && !isSplunkBoolLiteral(value)) {
    return [4, `Expected boolean value (true/false) for "${baseKey}", got "${value}"`];
  }
  if (info.valueType === 'number') {
    if (!isIntegerLiteral(value)) return [4, `Expected an integer for "${baseKey}", got "${value}"`];
    if (isDisallowedNegative(info.key, value)) {
      return [4, `"${baseKey}" cannot be negative — "${value}" will not do what it looks like it does`];
    }
  }
  if (info.valueType === 'enum' && info.enumValues && !isEnumMember(value, info.enumValues)) {
    return [4, `Invalid value "${value}" for "${baseKey}". Valid values: ${info.enumValues.join(', ')}`];
  }
  return null;
}

/** Value checks for a directive the registry knows. */
function checkKnownDirective(info: DirectiveInfo, d: DirectiveLine, markers: DiagnosticMarker[]): void {
  const { i, line, eqIdx, baseKey, value } = d;
  if (info.valueType === 'strftime' && value && !d.continued) checkStrftime(d, markers);

  const problem = value ? valueTypeProblem(info, baseKey, value) : null;
  if (problem) markers.push(lineMarker(i, problem[0], problem[1], eqIdx + 2, line.length + 1));

  // Best practice warnings
  // Check for a real CAPTURING group — not an escaped `\(` literal and not a
  // non-capturing `(?:…)` / lookaround `(?=…)` group.
  if (baseKey === 'LINE_BREAKER' && value && !hasCapturingGroup(value)) {
    markers.push(lineMarker(
      i,
      4,
      'LINE_BREAKER regex should contain at least one capturing group () — the captured content defines the break point',
      eqIdx + 2,
      line.length + 1,
    ));
  }

  if (info.deprecated) {
    markers.push(lineMarker(i, 2, `"${baseKey}" is deprecated — consider using the recommended alternative`, 1, eqIdx + 1));
  }
}

export function computeDiagnostics(
  model: editor.ITextModel,
  fileType: ConfFileType
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
    // The backslash must be the line's last character, as confParser reads it:
    // `\ ` (a space after it) is a literal backslash, not a continuation.
    const endsWithBackslash = endsWithContinuation(line);

    if (inDirectiveValue) {
      // Part of the previous directive's value — skip it, whatever it contains
      // (a `#` line or a blank one included), as confParser does. It continues
      // the value further only if it too ends with a trailing backslash.
      inDirectiveValue = endsWithBackslash;
      continue;
    }

    // Skip comments and blank lines. Splunk .conf uses `#` only — `;` is NOT a comment.
    // Like a directive, a comment or header must start the line: indented, it is
    // malformed to confParser, and reported below with the same reason.
    if (line.trim() === '' || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      const stanzaName = checkStanzaHeader(line, i, seenStanzas, markers);
      if (stanzaName !== null) {
        currentStanza = { name: stanzaName, directives: new Map() };
        stanzas.push(currentStanza);
      }
      continue;
    }

    // Directives. Recognised with the ENGINE's rule (`DIRECTIVE_RE`) rather than
    // a looser `indexOf('=')` test, so the editor and the diagnostics list agree
    // about what counts as a directive. In particular a leading-whitespace line
    // is malformed to Splunk, and gets a marker.
    if (!DIRECTIVE_RE.test(line)) {
      markers.push(malformedLineMarker(line, i));
      continue;
    }

    // This line is a directive — a trailing backslash now legitimately starts a
    // continuation onto the next line.
    inDirectiveValue = endsWithBackslash;

    const eqIdx = line.indexOf('=');
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

    const { info, baseKey } = resolveDirectiveInfo(key, fileType);
    if (!info) {
      const marker = unknownDirectiveMarker(key, fileType, i, eqIdx);
      if (marker) markers.push(marker);
      continue;
    }
    checkKnownDirective(info, { i, line, eqIdx, baseKey, value, continued: endsWithBackslash }, markers);
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
  let joined = firstFragment;
  for (let line = startLine + 1; line <= lineCount && endsWithContinuation(joined); line++) {
    joined = joined.slice(0, -1) + model.getLineContent(line);
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
 * Splunk resolves directives per stanza, so a `LINE_BREAKER` in one sourcetype
 * must not be silenced by a `SHOULD_LINEMERGE = false` in another, and each
 * marker lands on the offending stanza's own line.
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
    // wrong setting alongside a custom LINE_BREAKER, and must not suppress the
    // very warning that asks for `= false`.
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
