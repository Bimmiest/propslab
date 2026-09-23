// ---------------------------------------------------------------------------
// directiveRegistry.ts
// Comprehensive registry of Splunk props.conf and transforms.conf directives.
// Powers autocomplete, hover tooltips, linting, and validation features.
//
// Knowing a directive is not the same as simulating it. Every entry here also
// carries a `support` level from `directiveSupport.ts`, which is the declared
// boundary of what the preview actually honours (#153).
//
// The entries themselves are data, split by file and provenance under
// registry/; this module attaches the support levels and builds the lookups.
// ---------------------------------------------------------------------------

import { getDirectiveSupport } from './directiveSupport';
import type { DirectiveDefinition, DirectiveInfo } from './registry/types';
import { PROPS_CORE, PROPS_ADDITIONAL, PROPS_MISC } from './registry/propsDirectives';
import { TRANSFORMS_CORE, TRANSFORMS_ADDITIONAL } from './registry/transformsDirectives';
import { PROPS_SPEC_COMPLETENESS } from './registry/propsSpecDirectives';
import { TRANSFORMS_SPEC_COMPLETENESS } from './registry/transformsSpecDirectives';

export type { DirectiveInfo } from './registry/types';

// ---------------------------------------------------------------------------
// Directive definitions
// ---------------------------------------------------------------------------

// Interleaved, not grouped by file: this is the order the entries were written
// in, and it is the order completion, the dictionary and getAllDirectives()
// present them, so regrouping would reorder what users see.
const DIRECTIVE_DEFINITIONS: DirectiveDefinition[] = [
  ...PROPS_CORE,
  ...TRANSFORMS_CORE,
  ...PROPS_ADDITIONAL,
  ...TRANSFORMS_ADDITIONAL,
  ...PROPS_MISC,
  ...PROPS_SPEC_COMPLETENESS,
  ...TRANSFORMS_SPEC_COMPLETENESS,
];

/**
 * The registry as everything else reads it: each definition with its support
 * classification attached. An unclassified key defaults to `simulated` and is
 * caught by `directiveSupport.test.ts`, which is what stops the boundary from
 * quietly widening as directives are added.
 */
const DIRECTIVES: DirectiveInfo[] = DIRECTIVE_DEFINITIONS.map((d) => {
  const entry = getDirectiveSupport(d.key);
  return {
    ...d,
    support: entry?.support ?? 'simulated',
    supportNote: entry?.note,
    supportIssue: entry?.issue,
  };
});

// ---------------------------------------------------------------------------
// Build lookup maps for fast access
// ---------------------------------------------------------------------------

/**
 * Canonical map of all directives, keyed by their base key name.
 * When a key exists in both props.conf and transforms.conf (e.g. MATCH_LIMIT)
 * we keep both entries, so the lookup helpers filter by file at runtime.
 */
const directivesByKey = new Map<string, DirectiveInfo[]>();
// Same directives keyed by lowercased name, for case-insensitive lookups that
// detect case typos (Splunk attribute names are case-sensitive).
const directivesByLowerKey = new Map<string, DirectiveInfo[]>();

for (const d of DIRECTIVES) {
  const existing = directivesByKey.get(d.key);
  if (existing) {
    existing.push(d);
  } else {
    directivesByKey.set(d.key, [d]);
  }
  const lower = d.key.toLowerCase();
  const existingLower = directivesByLowerKey.get(lower);
  if (existingLower) {
    existingLower.push(d);
  } else {
    directivesByLowerKey.set(lower, [d]);
  }
}

// ---------------------------------------------------------------------------
// Class-based directive prefixes -- e.g. EXTRACT, REPORT, etc.
// ---------------------------------------------------------------------------

const CLASS_BASED_PREFIXES: string[] = DIRECTIVES
  .filter((d) => d.isClassBased)
  .map((d) => d.key);

// ---------------------------------------------------------------------------
// Exported helper functions
// ---------------------------------------------------------------------------

/**
 * Look up a directive by its key, scoped to a given configuration file.
 *
 * For class-based directives (e.g. "EXTRACT-myfield") the lookup uses the
 * base prefix ("EXTRACT").
 */
export function getDirectiveInfo(
  key: string,
  file: 'props.conf' | 'transforms.conf',
): DirectiveInfo | undefined {
  // Try an exact match first.
  const exact = directivesByKey.get(key);
  if (exact) {
    return exact.find((d) => d.appliesTo === file || d.appliesTo === 'both');
  }

  // Try matching a class-based prefix (e.g. "EXTRACT-myfield" -> "EXTRACT").
  const parsed = getClassBasedDirectiveBase(key);
  if (parsed) {
    const byBase = directivesByKey.get(parsed.base);
    if (byBase) {
      return byBase.find((d) => d.appliesTo === file || d.appliesTo === 'both');
    }
  }

  return undefined;
}

/**
 * When `key` is a real attribute of the OTHER conf file and not of `file`,
 * return the file it belongs in; otherwise undefined.
 *
 * `getDirectiveInfo` is file-aware but the support table is flat, so an
 * attribute written in the wrong file used to get two verdicts that contradict
 * each other: the engine found its support row and said "recognised but not
 * simulated", while the editor found no entry for this file and called it a
 * possible typo (#278). Neither is the problem. Splunk only reads an attribute
 * from the file whose spec defines it, so the line is dead, and the fix is to
 * move it -- both validators ask this one function so they give that answer
 * together.
 *
 * Only exact spellings count: a mis-cased key in the wrong file is still
 * reported as whatever the file it is in makes of it, since which of the two
 * mistakes the user made is not knowable.
 */
export function wrongFileCanonical(
  key: string,
  file: 'props.conf' | 'transforms.conf',
): 'props.conf' | 'transforms.conf' | undefined {
  if (getDirectiveInfo(key, file)) return undefined;
  const entries =
    directivesByKey.get(key) ??
    directivesByKey.get(getClassBasedDirectiveBase(key)?.base ?? '');
  if (!entries || entries.length === 0) return undefined;
  // Anything registered for 'both' would have been found above, so every
  // remaining entry names the other file.
  return file === 'props.conf' ? 'transforms.conf' : 'props.conf';
}

/** Shared wording, so the engine diagnostic and the editor marker read alike. */
export const WRONG_FILE_MESSAGE = (
  key: string,
  file: 'props.conf' | 'transforms.conf',
  belongsIn: 'props.conf' | 'transforms.conf',
): string => `${key} belongs in ${belongsIn}; in ${file} it has no effect.`;

/**
 * Return all directives that apply to the given configuration file.
 */
export function getDirectivesForFile(
  file: 'props.conf' | 'transforms.conf',
): DirectiveInfo[] {
  return DIRECTIVES.filter((d) => d.appliesTo === file || d.appliesTo === 'both');
}

/**
 * Return directives grouped by category for the given configuration file.
 */
export function getDirectivesByCategory(
  file: 'props.conf' | 'transforms.conf',
): Map<string, DirectiveInfo[]> {
  const result = new Map<string, DirectiveInfo[]>();
  for (const d of DIRECTIVES) {
    if (d.appliesTo !== file && d.appliesTo !== 'both') {
      continue;
    }
    const group = result.get(d.category);
    if (group) {
      group.push(d);
    } else {
      result.set(d.category, [d]);
    }
  }
  return result;
}

/**
 * Parse a class-based directive key like "EXTRACT-myfield" into its base
 * prefix and class name.  Returns null if the key is not class-based.
 */
export function getClassBasedDirectiveBase(
  key: string,
): { base: string; className: string } | null {
  const dashIndex = key.indexOf('-');
  if (dashIndex === -1) {
    return null;
  }

  const base = key.substring(0, dashIndex);
  const className = key.substring(dashIndex + 1);

  if (CLASS_BASED_PREFIXES.includes(base) && className.length > 0) {
    return { base, className };
  }

  return null;
}

/**
 * Return the full list of registered directives.  Useful for iteration in
 * autocomplete providers and documentation generators.
 */
export function getAllDirectives(): DirectiveInfo[] {
  return [...DIRECTIVES];
}

/**
 * Case-insensitive lookup → the canonical (correctly-cased) directive key, scoped
 * to a file. Returns undefined if no known directive matches case-insensitively.
 * Used to detect case typos: Splunk attribute names are case-sensitive, so a
 * mis-cased name (e.g. `kv_mode`) is silently ignored and the default applies.
 */
export function getCanonicalDirectiveKey(
  key: string,
  file: 'props.conf' | 'transforms.conf',
): string | undefined {
  const matches = directivesByLowerKey.get(key.toLowerCase());
  return matches?.find((d) => d.appliesTo === file || d.appliesTo === 'both')?.key;
}
