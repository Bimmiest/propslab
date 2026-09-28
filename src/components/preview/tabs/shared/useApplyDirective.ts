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

export interface ApplyDirective {
  /** The stanza generated directives are written into. */
  stanza: string;
  /** True when `stanza` is a placeholder because the event has no sourcetype. */
  isPlaceholderStanza: boolean;
  apply: (key: string, value: string) => void;
}

export function useApplyDirective(): ApplyDirective {
  const propsConf = useAppStore((s) => s.propsConf);
  const setPropsConf = useAppStore((s) => s.setPropsConf);
  const setMetadataField = useAppStore((s) => s.setMetadataField);
  const sourcetype = useAppStore((s) => s.metadata.sourcetype);
  const stanza = sourcetype.trim() || 'my:sourcetype';

  return {
    stanza,
    isPlaceholderStanza: stanza !== sourcetype,
    /**
     * When the event has no sourcetype we fall back to a placeholder stanza name
     * — but `matchStanzas` requires `metadata.sourcetype` to equal the stanza
     * name, so writing `[my:sourcetype]` alone would produce config that could
     * never match the event it was scaffolded from. Point the metadata at the
     * stanza too, the way ScaffoldModal already does.
     */
    apply: (key: string, value: string) => {
      setPropsConf(upsertDirectiveInStanza(propsConf, stanza, key, value));
      if (stanza !== sourcetype) setMetadataField('sourcetype', stanza);
    },
  };
}
