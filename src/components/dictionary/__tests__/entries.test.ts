import { describe, it, expect } from 'vitest';
import {
  buildEntries,
  filterEntries,
  findEntry,
  groupEntries,
  groupOf,
  DEFAULT_FILTERS,
  STANZA_GROUP,
  STANZA_ID_PREFIX,
} from '../entries';
import { getAllDirectives, STANZA_KINDS } from '../../../engine';

const ENTRIES = buildEntries();

describe('dictionary entries', () => {
  it('covers every directive in the registry plus every stanza kind', () => {
    expect(ENTRIES).toHaveLength(getAllDirectives().length + STANZA_KINDS.length);
  });

  it('gives every entry a unique id', () => {
    const ids = new Set(ENTRIES.map((e) => e.id));
    expect(ids.size).toBe(ENTRIES.length);
  });

  it('identifies directives by their bare key so deep links can use it', () => {
    const extract = ENTRIES.find((e) => e.id === 'EXTRACT');
    expect(extract?.kind).toBe('directive');
  });

  it('namespaces stanza ids so they cannot collide with a directive key', () => {
    for (const entry of ENTRIES) {
      if (entry.kind === 'stanza') expect(entry.id.startsWith(STANZA_ID_PREFIX)).toBe(true);
      else expect(entry.id.includes(':')).toBe(false);
    }
  });

  it('disambiguates keys the registry defines once per conf file', () => {
    // MATCH_LIMIT and DEPTH_LIMIT are registered twice with file-specific
    // wording, so their entries must not share an id — or one would shadow the
    // other in the list.
    const matchLimits = ENTRIES.filter((e) => e.kind === 'directive' && e.info.key === 'MATCH_LIMIT');
    expect(matchLimits).toHaveLength(2);
    expect(new Set(matchLimits.map((e) => e.id)).size).toBe(2);
  });

  it('titles every directive with its bare key — the conf file is a badge', () => {
    for (const entry of ENTRIES) {
      if (entry.kind === 'directive') expect(entry.title).toBe(entry.info.key);
    }
  });
});

describe('findEntry', () => {
  it('finds an entry by its exact id', () => {
    expect(findEntry(ENTRIES, 'TIME_PREFIX')?.id).toBe('TIME_PREFIX');
  });

  it('resolves a bare key for directives whose id carries the conf file', () => {
    const found = findEntry(ENTRIES, 'MATCH_LIMIT');
    expect(found?.kind).toBe('directive');
    expect(found?.kind === 'directive' && found.info.key).toBe('MATCH_LIMIT');
  });

  it('finds stanza entries by their prefixed id', () => {
    expect(findEntry(ENTRIES, 'stanza:source')?.kind).toBe('stanza');
  });

  it('returns undefined for null or unknown ids', () => {
    expect(findEntry(ENTRIES, null)).toBeUndefined();
    expect(findEntry(ENTRIES, 'NOT_A_DIRECTIVE')).toBeUndefined();
  });
});

describe('filterEntries', () => {
  it('returns everything with the default filters', () => {
    expect(filterEntries(ENTRIES, DEFAULT_FILTERS)).toHaveLength(ENTRIES.length);
  });

  it('matches search against the key', () => {
    const result = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, search: 'TIME_PREFIX' });
    expect(result.map((e) => e.id)).toContain('TIME_PREFIX');
  });

  it('matches search against the description, not just the key', () => {
    // "strftime" appears in TIME_FORMAT's prose but not in its key.
    const result = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, search: 'strftime' });
    expect(result.map((e) => e.id)).toContain('TIME_FORMAT');
  });

  it('is case-insensitive', () => {
    const lower = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, search: 'time_prefix' });
    const upper = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, search: 'TIME_PREFIX' });
    expect(lower.map((e) => e.id)).toEqual(upper.map((e) => e.id));
  });

  it('keeps only index-time directives when the phase filter is set', () => {
    const result = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, phase: 'index-time' });
    for (const entry of result) {
      if (entry.kind !== 'directive') continue;
      expect(['index-time', 'both']).toContain(entry.info.phase);
    }
    expect(result.some((e) => e.id === 'TIME_PREFIX')).toBe(true);
  });

  it('keeps `both`-phase directives under either phase filter', () => {
    const both = ENTRIES.find((e) => e.kind === 'directive' && e.info.phase === 'both');
    if (!both) return; // registry has some today; guard rather than assert the shape
    for (const phase of ['index-time', 'search-time'] as const) {
      const result = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, phase });
      expect(result.map((e) => e.id)).toContain(both.id);
    }
  });

  it('filters by conf file', () => {
    const result = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, file: 'transforms.conf' });
    for (const entry of result) {
      if (entry.kind !== 'directive') continue;
      expect(['transforms.conf', 'both']).toContain(entry.info.appliesTo);
    }
  });

  it('keeps stanza headers visible under every non-search filter', () => {
    const result = filterEntries(ENTRIES, {
      search: '',
      phase: 'search-time',
      file: 'transforms.conf',
      hideDeprecated: true,
    });
    expect(result.filter((e) => e.kind === 'stanza')).toHaveLength(STANZA_KINDS.length);
  });

  it('hides stanza headers that do not match the search', () => {
    const result = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, search: 'zzzznotathing' });
    expect(result).toHaveLength(0);
  });

  it('drops deprecated directives when asked', () => {
    const result = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, hideDeprecated: true });
    expect(result.some((e) => e.kind === 'directive' && e.info.deprecated)).toBe(false);
  });
});

describe('groupEntries', () => {
  it('puts stanza headers in their own group, first', () => {
    const groups = groupEntries(filterEntries(ENTRIES, DEFAULT_FILTERS));
    expect(groups[0]?.group).toBe(STANZA_GROUP);
  });

  it('groups directives by their registry category', () => {
    const groups = groupEntries(filterEntries(ENTRIES, DEFAULT_FILTERS));
    for (const { group, entries } of groups) {
      for (const entry of entries) expect(groupOf(entry)).toBe(group);
    }
  });

  it('loses no entries', () => {
    const visible = filterEntries(ENTRIES, { ...DEFAULT_FILTERS, phase: 'search-time' });
    const grouped = groupEntries(visible).flatMap((g) => g.entries);
    expect(grouped).toHaveLength(visible.length);
  });
});
