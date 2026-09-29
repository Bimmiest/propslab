/**
 * Reading one attribute out of a directive list, and reading a conf boolean.
 *
 * Every processor reads through these — last match, trimmed where it matters,
 * one boolean spelling table — so the same spelling cannot switch one
 * attribute on and be ignored by the next.
 */
import type { ConfDirective } from '../types';
import { validateRegex } from '../../utils/splunkRegex';

/**
 * The directive that takes effect for `key`: the LAST one in the list.
 *
 * Last, because that is Splunk's rule for a key repeated within a stanza, and
 * because a layered conf is concatenated lowest precedence first, so the
 * last definition is also the `local/` one that beat `default/`. The lists this
 * is handed come in two shapes, and last-wins is right for both:
 *
 *   - props, after `mergeDirectives`: already one directive per key, so first
 *     and last are the same directive and the choice is moot;
 *   - a single stanza's `directives` (a transforms.conf stanza, or a props
 *     stanza read before merging): NOT deduplicated — `mergeDuplicateStanzas`
 *     concatenates repeats — so first-match would return a shadowed value.
 */
export function effectiveDirective(directives: readonly ConfDirective[], key: string): ConfDirective | undefined {
  for (let i = directives.length - 1; i >= 0; i--) {
    const directive = directives[i];
    if (directive?.key === key) return directive;
  }
  return undefined;
}

/**
 * The effective value of `key`, trimmed — or undefined when the key is absent.
 *
 * Trimmed because the parser keeps trailing whitespace (Splunk does too), and
 * no setting read through this is whitespace-sensitive. A regex or a FORMAT
 * can be, which is why those read the directive itself instead.
 */
export function effectiveValue(directives: readonly ConfDirective[], key: string): string | undefined {
  return effectiveDirective(directives, key)?.value.trim();
}

/**
 * Splunk's spellings for a conf `<boolean>`, compared case-insensitively.
 *
 * The widest set any reader here accepted, and the one splunk.util's
 * `normalizeBoolean` uses: the words, their initials, on/off, and 1/0.
 */
const TRUE_SPELLINGS = new Set(['1', 'true', 't', 'yes', 'y', 'on']);
const FALSE_SPELLINGS = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

/** Whether `value` is one of Splunk's boolean spellings (after trimming, any case). */
export function isSplunkBoolLiteral(value: string): boolean {
  const v = value.trim().toLowerCase();
  return TRUE_SPELLINGS.has(v) || FALSE_SPELLINGS.has(v);
}

/**
 * Read a conf boolean the way Splunk does: the true spellings are true and
 * EVERYTHING else is false (splunk.util's `normalizeBoolean`). Only an absent or
 * empty value takes `defaultValue`: an empty assignment resets the setting to
 * its default, whereas `ANNOTATE_PUNCT = nope` is a value Splunk reads, and
 * reads as false. The directive linter reports such a value; this is what the
 * preview then does with it, so the two say the same thing.
 */
export function parseSplunkBool(value: string | undefined, defaultValue: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '') return defaultValue;
  return TRUE_SPELLINGS.has(v);
}

/** `parseSplunkBool` of the effective value of `key`. */
export function effectiveBool(directives: readonly ConfDirective[], key: string, defaultValue: boolean): boolean {
  return parseSplunkBool(effectiveDirective(directives, key)?.value, defaultValue);
}

// ---------------------------------------------------------------------------
// Value predicates shared by the engine's directive lint and the editor's
// diagnostics. Both read a directive's value through these, so a value cannot
// be an error in one and fine in the other.
// ---------------------------------------------------------------------------

/** Whether `value` (trimmed) is an integer as Splunk reads one: optional sign, digits only. */
export function isIntegerLiteral(value: string): boolean {
  return /^[+-]?\d+$/.test(value.trim());
}

/**
 * Numeric directives the spec documents as non-negative. A negative here is not
 * merely odd — Splunk treats it as unset, so the setting silently does nothing.
 */
const NON_NEGATIVE = new Set([
  'TRUNCATE',
  'MAX_EVENTS',
  'MAX_TIMESTAMP_LOOKAHEAD',
  'MAX_DAYS_AGO',
  'MAX_DAYS_HENCE',
  'MAX_DIFF_SECS_AGO',
  'MAX_DIFF_SECS_HENCE',
  'MATCH_LIMIT',
  'DEPTH_LIMIT',
  'LINE_BREAKER_LOOKBEHIND',
  'HEADER_FIELD_LINE_NUMBER',
]);

/**
 * The one negative a non-negative directive documents as meaningful.
 * props.conf.spec: MAX_TIMESTAMP_LOOKAHEAD "0 or -1 disables the length
 * constraint", so -1 is a correct setting, not a broken one.
 */
const NEGATIVE_SENTINELS: Readonly<Record<string, string>> = {
  MAX_TIMESTAMP_LOOKAHEAD: '-1',
};

/** Whether `key` is documented as non-negative and `value` is a negative that is not its sentinel. */
export function isDisallowedNegative(key: string, value: string): boolean {
  const v = value.trim();
  return v.startsWith('-') && NON_NEGATIVE.has(key) && NEGATIVE_SENTINELS[key] !== v;
}

/**
 * Whether `value` is a member of an enum. Case-insensitive, and `multi:<stanza>`
 * (the one member that carries an argument) is matched on the part before the
 * colon.
 */
export function isEnumMember(value: string, enumValues: readonly string[]): boolean {
  const v = value.trim().toLowerCase();
  const allowed = enumValues.map((e) => e.toLowerCase());
  return allowed.includes(v) || allowed.includes(v.split(':')[0] ?? '');
}

/** Why `pattern` does not compile as a Splunk regex, or null when it does. */
export function regexProblem(pattern: string): string | null {
  return validateRegex(pattern);
}
