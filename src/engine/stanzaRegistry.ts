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

export const STANZA_KINDS: StanzaKind[] = [
  {
    id: 'default',
    label: '[default]',
    description:
      'Default stanza that applies to all sourcetypes. Settings here provide baseline configuration that can be overridden by more specific stanzas.',
    rank: 0,
    precedence: 'Lowest — overridden by [sourcetype], [host::*], and [source::*].',
    patternSyntax: [],
    example: '[default]',
  },
  {
    id: 'sourcetype',
    label: '[<sourcetype>]',
    description:
      'Sourcetype stanza — applies to events whose sourcetype matches the header exactly. This is the stanza type most props.conf settings belong in.',
    rank: 1,
    precedence: 'Overrides [default]; overridden by [host::*] and [source::*].',
    patternSyntax: [],
    example: '[apache:access]',
  },
  {
    id: 'host',
    label: '[host::<pattern>]',
    description:
      'Host-based stanza matching a hostname pattern. Use it to apply settings to data from particular machines regardless of sourcetype.',
    rank: 2,
    precedence: 'Overrides [sourcetype] and [default]; overridden by [source::*].',
    patternSyntax: [
      '`*` matches any characters',
      'More specific patterns take precedence',
    ],
    example: '[host::web-*.example.com]',
  },
  {
    id: 'source',
    label: '[source::<pattern>]',
    description:
      'Source-based stanza matching a source path pattern. Use it when the file or input path, rather than the sourcetype, determines how data should be handled.',
    rank: 3,
    precedence: 'Highest — overrides all other stanza types.',
    patternSyntax: [
      '`*` matches any characters within a path segment',
      '`...` matches any path segments (recursive wildcard)',
      'More specific patterns take precedence over less specific ones',
    ],
    example: '[source::/var/log/.../*.log]',
  },
];

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
    return { kind: stanzaKindsById.get('source')!, pattern: stanzaName.slice('source::'.length) };
  }
  if (stanzaName.startsWith('host::')) {
    return { kind: stanzaKindsById.get('host')!, pattern: stanzaName.slice('host::'.length) };
  }
  if (stanzaName === 'default') {
    return { kind: stanzaKindsById.get('default')!, pattern: null };
  }
  return { kind: stanzaKindsById.get('sourcetype')!, pattern: stanzaName };
}
