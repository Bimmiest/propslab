import type { ConfDirective, ValidationDiagnostic } from '../types';
import { atDirective } from '../parser/provenance';

/**
 * Helpers for field-name references in props.conf directives (FIELDALIAS,
 * EXTRACT ... in, EVAL). Splunk requires a field name containing any character
 * outside [A-Za-z0-9_] to be wrapped in single (or double) quotes when it is
 * referenced — e.g. a nested-JSON field like `event.field`. These helpers
 * normalise a raw token and flag bare names that need quoting, so every
 * processor applies the same rule and emits the same diagnostic.
 */

/** True if the trimmed token is wrapped in a matched pair of single or double quotes. */
export function isQuotedFieldName(token: string): boolean {
  const t = token.trim();
  return t.length >= 2 && ((t[0] === "'" && t[t.length - 1] === "'") || (t[0] === '"' && t[t.length - 1] === '"'));
}

/** Strip one layer of matched surrounding quotes, returning the literal field name. */
export function unquoteFieldName(token: string): string {
  const t = token.trim();
  return isQuotedFieldName(t) ? t.slice(1, -1) : t;
}

/**
 * True if a literal (already-unquoted) field name must be single-quoted to be
 * referenced in Splunk: any character outside [A-Za-z0-9_]. `allowWildcard`
 * permits `*` without flagging it, for slots where `*` is a wildcard token.
 */
export function fieldNameNeedsQuoting(name: string, opts?: { allowWildcard?: boolean }): boolean {
  return (opts?.allowWildcard ? /[^A-Za-z0-9_*]/ : /[^A-Za-z0-9_]/).test(name);
}

/**
 * Standard "this bare field name needs single quotes" warning, shared across the
 * field-referencing directives. `reason` is the directive-specific explanation of
 * why the unquoted form fails (e.g. eval's `.` being the concat operator).
 */
export function fieldQuotingWarning(dir: ConfDirective, bareName: string, reason: string): ValidationDiagnostic {
  return {
    level: 'warning',
    message: `${dir.key}: "${bareName}" ${reason} — single-quote it: '${bareName}'.`,
    file: 'props.conf',
    ...atDirective(dir),
    directiveKey: dir.key,
    suggestion: `Use '${bareName}' instead of ${bareName}.`,
  };
}
