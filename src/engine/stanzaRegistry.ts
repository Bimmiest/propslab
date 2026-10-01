// ---------------------------------------------------------------------------
// stanzaRegistry.ts
// The stanza header kinds a props.conf file can declare, their precedence, and
// their pattern syntax. The Monaco hover provider and the dictionary both
// render from this one source.
// ---------------------------------------------------------------------------

export type StanzaKindId = 'default' | 'sourcetype' | 'host' | 'source';

export interface StanzaKind {
  id: StanzaKindId;
  /** Display form of the header, e.g. "[host::<pattern>]". */
  label: string;
  description: string;
  /**
   * Precedence rank. Higher wins when several stanzas match the same event —
   * this mirrors Splunk's ordering, where source beats host beats sourcetype
   * beats default.
   */
  rank: number;
  /** Prose form of the ranking, for display. */
  precedence: string;
  /** Pattern syntax notes; empty for stanza kinds that take no pattern. */
  patternSyntax: string[];
  example: string;
}

const DEFAULT_KIND: StanzaKind = {
  id: 'default',
  label: '[default]',
  description:
    'Default stanza that applies to all sourcetypes. Settings here provide baseline configuration that can be overridden by more specific stanzas.',
  rank: 0,
  precedence: 'Lowest — overridden by [sourcetype], [host::*], and [source::*].',
  patternSyntax: [],
  example: '[default]',
};

const SOURCETYPE_KIND: StanzaKind = {
  id: 'sourcetype',
  label: '[<sourcetype>]',
  description:
    'Sourcetype stanza — applies to events whose sourcetype matches the header exactly. This is the stanza type most props.conf settings belong in.',
  rank: 1,
  precedence: 'Overrides [default]; overridden by [host::*] and [source::*].',
  patternSyntax: [],
  example: '[apache:access]',
};

const HOST_KIND: StanzaKind = {
  id: 'host',
  label: '[host::<pattern>]',
  description:
    'Host-based stanza matching a hostname pattern. Use it to apply settings to data from particular machines regardless of sourcetype.',
  rank: 2,
  precedence: 'Overrides [sourcetype] and [default]; overridden by [source::*].',
  patternSyntax: [
    'A PCRE regular expression, matched against the whole host name',
    '`*` matches any characters except `/` and `\\`, `...` matches any characters, and `.` matches a period',
    'Case-insensitive; `(?-i)` in the pattern makes it case-sensitive',
    'Among matching host stanzas of equal `priority`, the name first in ASCII order wins',
  ],
  example: '[host::web-*.example.com]',
};

const SOURCE_KIND: StanzaKind = {
  id: 'source',
  label: '[source::<pattern>]',
  description:
    'Source-based stanza matching a source path pattern. Use it when the file or input path, rather than the sourcetype, determines how data should be handled.',
  rank: 3,
  precedence: 'Highest — overrides all other stanza types.',
  patternSyntax: [
    'With `*` or `...` in it, a PCRE regular expression matched against the whole source',
    '`*` matches any characters within a path segment, `...` matches across segments, and `.` matches a period',
    'With neither, compared with the source exactly as written',
    'Case-sensitive',
    'Among matching source stanzas of equal `priority`, the name first in ASCII order wins',
  ],
  example: '[source::/var/log/.../*.log]',
};

export const STANZA_KINDS: StanzaKind[] = [DEFAULT_KIND, SOURCETYPE_KIND, HOST_KIND, SOURCE_KIND];

const stanzaKindsById = new Map(STANZA_KINDS.map((s) => [s.id, s]));

export function getStanzaKind(id: StanzaKindId): StanzaKind | undefined {
  return stanzaKindsById.get(id);
}

/**
 * Classify a stanza header's inner text (the part between the brackets) into
 * one of the four kinds, and split off the pattern where there is one.
 *
 * The `host::` / `source::` prefixes are matched case-sensitively, matching
 * Splunk: `[HOST::web-1]` is a sourcetype literally named "HOST::web-1".
 */
export function classifyStanza(stanzaName: string): { kind: StanzaKind; pattern: string | null } {
  if (stanzaName.startsWith('source::')) {
    return { kind: SOURCE_KIND, pattern: stanzaName.slice('source::'.length) };
  }
  if (stanzaName.startsWith('host::')) {
    return { kind: HOST_KIND, pattern: stanzaName.slice('host::'.length) };
  }
  if (stanzaName === 'default') {
    return { kind: DEFAULT_KIND, pattern: null };
  }
  return { kind: SOURCETYPE_KIND, pattern: stanzaName };
}
