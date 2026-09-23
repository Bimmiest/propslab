/**
 * Reading one attribute out of a directive list, and reading a conf boolean.
 *
 * Every processor used to do both its own way — first match or last, trimmed
 * or not, `=== 'true'` or `!== 'false'` — so the same spelling could switch one
 * attribute on and be ignored by the next (#301). These are the one reading.
 */
import type { ConfDirective } from '../types';

/**
 * The directive that takes effect for `key`: the LAST one in the list.
 *
 * Last, because that is Splunk's rule for a key repeated within a stanza, and
 * because a layered conf (#132) is concatenated lowest precedence first, so the
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
 * Read a conf boolean, falling back to `defaultValue` when it is absent, empty
 * or not a boolean spelling at all.
 *
 * An unrecognised value takes the default rather than a fixed `false` because
 * that is what every reader here already did with one — `=== 'true'` readers of
 * default-false settings and `!== 'false'` readers of default-true ones — and
 * the directive linter is what reports such a value. Only the recognised
 * spellings were ever inconsistent.
 */
export function parseSplunkBool(value: string | undefined, defaultValue: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (v === undefined) return defaultValue;
  if (TRUE_SPELLINGS.has(v)) return true;
  if (FALSE_SPELLINGS.has(v)) return false;
  return defaultValue;
}

/** `parseSplunkBool` of the effective value of `key`. */
export function effectiveBool(directives: readonly ConfDirective[], key: string, defaultValue: boolean): boolean {
  return parseSplunkBool(effectiveDirective(directives, key)?.value, defaultValue);
}
