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

/**
 * Subscribes to the sourcetype alone, which names the stanza shown. The
 * props.conf text is read from the store when a directive is applied: every
 * event card and Raw row has a context menu that calls this, and subscribed
 * to props.conf each of them re-rendered on every keystroke in the editor.
 */
export function useApplyDirective(): ApplyDirective {
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
      const { propsConf, setPropsConf, setMetadataField } = useAppStore.getState();
      setPropsConf(upsertDirectiveInStanza(propsConf, stanza, key, value));
      if (stanza !== sourcetype) setMetadataField('sourcetype', stanza);
    },
  };
}
