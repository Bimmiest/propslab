// ---------------------------------------------------------------------------
// useApplyDirective.ts
// Write a generated directive into the event's sourcetype stanza.
//
// Shared by the event context menu's scaffolds and the Regex tab's one-click
// "Add to props.conf". The sourcetype fallback below is subtle enough
// that two copies of it would eventually become one copy and one bug.
// ---------------------------------------------------------------------------

import { useAppStore } from '../../../../store/useAppStore';
import { upsertDirectiveInStanza } from '../../../../engine/scaffold/serialize';
import { getDirectiveInfo } from '../../../../engine/directiveRegistry';

const PLACEHOLDER_STANZA = 'my:sourcetype';

export interface ApplyDirective {
  /** The stanza a generated search-time directive (EXTRACT) is written into. */
  stanza: string;
  /** The stanza `key` is written into: index-time keys skip a `rename`. */
  stanzaFor: (key: string) => string;
  /** True when `stanza` is a placeholder because the event has no sourcetype. */
  isPlaceholderStanza: boolean;
  apply: (key: string, value: string) => void;
}

/**
 * Subscribes to the sourcetypes alone, which name the stanza shown. The
 * props.conf text is read from the store when a directive is applied: every
 * event card and Raw row has a context menu that calls this, and subscribed
 * to props.conf each of them re-rendered on every keystroke in the editor.
 *
 * The stanza is the one the event uses, not the one the Metadata panel names:
 * a `[source::]` or `[host::]` stanza can assign the sourcetype at input, and
 * a directive written under the typed name would never match (#611).
 * `eventSourcetype` is the event's own, for the event menu; without it, or
 * when it is empty, the run's input sourcetype after any such assignment
 * stands in, then the typed one. Search-time
 * directives on that stanza stop applying when it has a `rename`, so they go
 * to the rename target instead.
 */
export function useApplyDirective(eventSourcetype?: string): ApplyDirective {
  const typed = useAppStore((s) => s.metadata.sourcetype);
  const resolved = useAppStore((s) => s.processingResult?.inputMetadata.sourcetype);
  const renamed = useAppStore((s) => s.processingResult?.renamedSourcetype);

  const indexTimeStanza = eventSourcetype?.trim() || resolved?.trim() || typed.trim() || PLACEHOLDER_STANZA;
  const renameApplies = renamed !== undefined && indexTimeStanza === resolved?.trim();
  const searchTimeStanza = renameApplies ? renamed : indexTimeStanza;
  const stanzaFor = (key: string) =>
    getDirectiveInfo(key, 'props.conf')?.phase === 'search-time' ? searchTimeStanza : indexTimeStanza;
  const isPlaceholderStanza = indexTimeStanza === PLACEHOLDER_STANZA && typed.trim() === '';

  return {
    stanza: searchTimeStanza,
    stanzaFor,
    isPlaceholderStanza,
    /**
     * When the event has no sourcetype we fall back to a placeholder stanza name
     * — but `matchStanzas` requires `metadata.sourcetype` to equal the stanza
     * name, so writing `[my:sourcetype]` alone would produce config that could
     * never match the event it was scaffolded from. Point the metadata at the
     * stanza too, the way ScaffoldModal already does.
     */
    apply: (key: string, value: string) => {
      const { propsConf, setPropsConf, setMetadataField } = useAppStore.getState();
      setPropsConf(upsertDirectiveInStanza(propsConf, stanzaFor(key), key, value));
      if (isPlaceholderStanza) setMetadataField('sourcetype', PLACEHOLDER_STANZA);
    },
  };
}
