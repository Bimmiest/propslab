// ---------------------------------------------------------------------------
// misspelledDirective.ts
// The attribute that an unknown key is a typo of: one edit from it, where an
// edit is an extra, missing or wrong character, or two adjacent characters
// in the wrong order (`TIME_FROMAT` for `TIME_FORMAT`).
//
// Splunk ignores an attribute it does not know, and says nothing, so the
// default applies and the line is dead. The parser reports it with the
// suggestion, which the pipeline and the MCP server's `validate` both show,
// and the editor's linter marks it with the same sentence.
// ---------------------------------------------------------------------------

import { getDirectiveInfo, getDirectivesForFile, wrongFileCanonical } from './directiveRegistry';
import { isUndocumentedAttribute } from './directiveSupport';

type ConfFile = 'props.conf' | 'transforms.conf';

/**
 * Shorter keys are not checked: with three letters or fewer, one edit reaches
 * too many real attributes for a suggestion to mean anything.
 */
const MIN_KEY_LENGTH = 4;

/** Longer keys are not checked, so a pathological key costs nothing. No attribute is near this long. */
const MAX_KEY_LENGTH = 64;

/**
 * The attributes of one file, indexed for a one-edit search. Each attribute is
 * found under its lower-case spelling and under each spelling with one
 * character deleted. Two keys one edit apart share one of these spellings, so
 * a search builds the same spellings of the key and looks each one up: a
 * few dozen lookups, not a comparison with every attribute.
 */
interface TypoIndex {
  byVariant: Map<string, Set<string>>;
}

/** `word`, and each spelling of it with one character deleted. */
function deletions(word: string): string[] {
  return [word, ...Array.from(word, (_, i) => word.slice(0, i) + word.slice(i + 1))];
}

function buildIndex(keys: readonly string[]): TypoIndex {
  const byVariant = new Map<string, Set<string>>();
  for (const key of keys) {
    for (const variant of deletions(key.toLowerCase())) {
      const found = byVariant.get(variant);
      if (found) found.add(key);
      else byVariant.set(variant, new Set([key]));
    }
  }
  return { byVariant };
}

/**
 * Whether `a` and `b` are exactly one edit apart. Both are the same case. Equal
 * strings are zero edits apart, so they are not.
 */
export function isOneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  // The first difference. Two different strings have one, if only where the
  // shorter one has ended.
  let i = 0;
  while (a[i] === b[i]) i++;
  if (a.length === b.length) {
    // A substitution at i, or two adjacent characters swapped there.
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  // One character more in either string, at i. Only one of the two can hold,
  // and neither does when the lengths differ by more than one.
  return a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
}

/** The one key of the index that is one edit from `word`, or undefined if none is, or more than one is. */
function closest(word: string, index: TypoIndex): string | undefined {
  const lower = word.toLowerCase();
  const found = new Set<string>();
  for (const variant of deletions(lower)) {
    const keys = index.byVariant.get(variant);
    if (!keys) continue;
    for (const key of keys) {
      if (isOneEditApart(lower, key.toLowerCase())) found.add(key);
    }
  }
  if (found.size !== 1) return undefined;
  const [only] = found;
  return only;
}

const indexes = new Map<string, TypoIndex>();

/** The index of the plain attributes or of the class prefixes of `file`, built at first use. */
function indexFor(file: ConfFile, classBased: boolean): TypoIndex {
  const id = `${file}:${String(classBased)}`;
  const cached = indexes.get(id);
  if (cached) return cached;
  const keys = getDirectivesForFile(file)
    .filter((d) => d.isClassBased === classBased)
    .map((d) => d.key);
  const built = buildIndex(keys);
  indexes.set(id, built);
  return built;
}

/**
 * The attribute of `file` that `rawKey` is a typo of, or undefined when the
 * key is a real attribute, or is not one edit from exactly one attribute.
 *
 * A key that differs only by case is not a typo here: `miscasedCanonical` in
 * the parser reports it, with its own sentence. A key that is real in the other
 * file is reported by `wrongFileCanonical`, and a real attribute that the
 * registry does not document is not a typo at all.
 *
 * In a class key (`EXTRCT-ip`) the part before the first `-` is compared with
 * the class prefixes, and the class name is kept.
 */
export function misspelledCanonical(rawKey: string, file: ConfFile): string | undefined {
  if (rawKey.length < MIN_KEY_LENGTH || rawKey.length > MAX_KEY_LENGTH) return undefined;
  if (getDirectiveInfo(rawKey, file) !== undefined) return undefined;
  if (wrongFileCanonical(rawKey, file) !== undefined || isUndocumentedAttribute(rawKey)) return undefined;

  const dash = rawKey.indexOf('-');
  // A class key needs a class name after the dash, as the parser reads one.
  if (dash > 0 && dash < rawKey.length - 1) {
    const prefix = closest(rawKey.slice(0, dash), indexFor(file, true));
    if (prefix !== undefined) return prefix + rawKey.slice(dash);
  }
  return closest(rawKey, indexFor(file, false));
}

/** Shared wording, so the engine diagnostic and the editor marker read alike. */
export const MISSPELLED_MESSAGE = (rawKey: string, canonical: string, file: ConfFile): string =>
  `"${rawKey}" is not a ${file} attribute, so Splunk ignores the line. Did you mean "${canonical}"?`;
