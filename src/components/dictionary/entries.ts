import { getAllDirectives, type DirectiveInfo } from '../../engine/directiveRegistry';
import { STANZA_KINDS, type StanzaKind } from '../../engine/stanzaRegistry';

/**
 * One selectable thing in the dictionary. Stanza headers and directives are
 * browsed in the same list but carry different fields, so they stay distinct
 * shapes rather than being flattened into a lowest common denominator.
 */
export type DictionaryEntry =
  | { kind: 'directive'; id: string; title: string; info: DirectiveInfo }
  | { kind: 'stanza'; id: string; title: string; stanza: StanzaKind };

/**
 * Entry ids are the directive key ("TIME_PREFIX") or a `stanza:`-prefixed
 * stanza id ("stanza:source"). One flat string keeps `dictionarySelection` in
 * the store simple enough to deep-link to from a Monaco command or a command
 * palette item; the prefix is unambiguous because no Splunk directive key
 * contains a colon.
 */
export const STANZA_ID_PREFIX = 'stanza:';

/**
 * A few settings (MATCH_LIMIT, DEPTH_LIMIT) are registered once per conf file
 * with file-specific wording, so their keys are not unique. Those get the file
 * appended to keep ids distinct; every other key is used bare, so the common
 * case stays deep-linkable as just "TIME_PREFIX".
 */
export const FILE_ID_SEPARATOR = '@';

export const STANZA_GROUP = 'Stanza Headers';

export function buildEntries(): DictionaryEntry[] {
  const stanzas: DictionaryEntry[] = STANZA_KINDS.map((stanza) => ({
    kind: 'stanza',
    id: `${STANZA_ID_PREFIX}${stanza.id}`,
    title: stanza.label,
    stanza,
  }));

  const all = getAllDirectives();
  const keyCounts = new Map<string, number>();
  for (const info of all) keyCounts.set(info.key, (keyCounts.get(info.key) ?? 0) + 1);

  const directives: DictionaryEntry[] = all.map((info) => {
    const ambiguous = (keyCounts.get(info.key) ?? 0) > 1;
    return {
      kind: 'directive',
      id: ambiguous ? `${info.key}${FILE_ID_SEPARATOR}${info.appliesTo}` : info.key,
      // The title is always the bare key. Which conf file an entry belongs to is
      // a property of every directive, so it is a badge on every row next to the
      // phase — not a parenthetical on the two keys that happen to need
      // disambiguating.
      title: info.key,
      info,
    };
  });

  return [...stanzas, ...directives];
}

/**
 * Find the entry a stored selection refers to.
 *
 * Deep links carry a bare directive key, which is all a Monaco hover or a
 * command palette item knows. For the handful of keys that exist once per conf
 * file that key matches no id exactly, so fall back to the first entry for it —
 * arbitrary between two near-identical records, and far better than showing
 * nothing.
 */
export function findEntry(entries: DictionaryEntry[], id: string | null): DictionaryEntry | undefined {
  if (!id) return undefined;
  return (
    entries.find((entry) => entry.id === id) ??
    entries.find((entry) => entry.kind === 'directive' && entry.info.key === id)
  );
}

/** Group heading an entry belongs under in the browse list. */
export function groupOf(entry: DictionaryEntry): string {
  return entry.kind === 'stanza' ? STANZA_GROUP : entry.info.category;
}

export interface DictionaryFilters {
  search: string;
  phase: 'all' | 'index-time' | 'search-time';
  file: 'all' | 'props.conf' | 'transforms.conf';
  hideDeprecated: boolean;
}

export const DEFAULT_FILTERS: DictionaryFilters = {
  search: '',
  phase: 'all',
  file: 'all',
  hideDeprecated: false,
};

/**
 * Apply the filter bar to the entry list.
 *
 * Stanza headers survive every filter except search. They are props.conf-only
 * and index-time-ish, but filtering them out when someone narrows to
 * "search-time" would hide the thing that decides which stanza a setting even
 * belongs in — and they are only four rows.
 */
export function filterEntries(entries: DictionaryEntry[], filters: DictionaryFilters): DictionaryEntry[] {
  const needle = filters.search.trim().toLowerCase();

  return entries.filter((entry) => {
    if (needle) {
      const haystack =
        entry.kind === 'stanza'
          ? `${entry.title} ${entry.stanza.description}`
          : `${entry.info.key} ${entry.info.description} ${entry.info.category}`;
      if (!haystack.toLowerCase().includes(needle)) return false;
    }

    if (entry.kind === 'stanza') return true;

    // `phase: 'both'` directives match either phase filter — a directive that
    // runs at index AND search time is relevant to someone browsing either.
    if (filters.phase !== 'all' && entry.info.phase !== 'both' && entry.info.phase !== filters.phase) {
      return false;
    }
    if (filters.file !== 'all' && entry.info.appliesTo !== 'both' && entry.info.appliesTo !== filters.file) {
      return false;
    }
    if (filters.hideDeprecated && entry.info.deprecated) return false;

    return true;
  });
}

/**
 * Group entries for display, preserving the registry's category order and
 * keeping stanza headers pinned to the top.
 */
export function groupEntries(entries: DictionaryEntry[]): { group: string; entries: DictionaryEntry[] }[] {
  const groups = new Map<string, DictionaryEntry[]>();
  for (const entry of entries) {
    const group = groupOf(entry);
    const existing = groups.get(group);
    if (existing) existing.push(entry);
    else groups.set(group, [entry]);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, entries: list }));
}
