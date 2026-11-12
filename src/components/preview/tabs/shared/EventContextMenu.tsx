import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ViewEvent } from '../../../../utils/viewResult';
import { copyQuietly } from '../../../../utils/clipboard';
import { useApplyDirective } from './useApplyDirective';
import { ExtractNameDialog } from './ExtractNameDialog';
import { TimePrefixDialog } from './TimePrefixDialog';
import { matchedStanzas } from './fieldDirective';
import { useAppStore } from '../../../../store/useAppStore';
import { revealInEditor } from '../../../editor/revealInEditor';
import { FieldMenuItems } from './FieldMenuItems';
import type { FieldTarget } from './fieldSpans';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from '../../../ui/ContextMenu';
import { Identifier } from '../../../ui/Identifier';

function currentSelection(): string {
  return (typeof window !== 'undefined' ? (window.getSelection()?.toString() ?? '') : '').trim();
}

/** The metadata as Splunk writes it in a search: `index=… host=… source=… sourcetype=…`. */
function metadataLine(m: ViewEvent['metadata']): string {
  return `index=${m.index} host=${m.host} source=${m.source} sourcetype=${m.sourcetype}`;
}

/**
 * "Jump to [stanza]" for each stanza that applies to the event, in precedence
 * order (#759). Rendered only while the menu is open, so it parses the
 * editor's props.conf as it is now, whose lines the jump lands on.
 */
function StanzaItems({ event }: { event: ViewEvent }) {
  const stanzas = matchedStanzas(useAppStore.getState().propsConf, event.metadata);
  if (stanzas.length === 0) {
    return (
      <ContextMenuItem disabled onSelect={() => {}}>
        No stanza in props.conf matches this event
      </ContextMenuItem>
    );
  }
  return stanzas.map(({ name, line }) => (
    <ContextMenuItem key={`${name}:${line}`} onSelect={() => revealInEditor('props.conf', line)}>
      Jump to [{name}]
    </ContextMenuItem>
  ));
}

/** The items of the event menu, with the scaffold items while text is selected. */
function EventItems({
  event,
  selection,
  stanza,
  onExtract,
  onTimePrefix,
}: {
  event: ViewEvent;
  selection: string;
  stanza: string;
  onExtract: () => void;
  onTimePrefix: () => void;
}) {
  return (
    <>
      <ContextMenuItem onSelect={() => copyQuietly(event._raw)}>Copy event</ContextMenuItem>
      {Object.keys(event.fields).length > 0 && (
        <ContextMenuItem onSelect={() => copyQuietly(JSON.stringify(event.fields, null, 2))}>
          Copy fields as JSON
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => copyQuietly(metadataLine(event.metadata))}>Copy metadata</ContextMenuItem>
      <ContextMenuSeparator />
      <StanzaItems event={event} />
      {selection.length > 0 && (
        <>
          <ContextMenuItem onSelect={() => copyQuietly(selection)}>Copy selection</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuLabel>
            Scaffold from selection → <Identifier>[{stanza}]</Identifier>
          </ContextMenuLabel>
          <ContextMenuItem onSelect={onExtract}>Create EXTRACT…</ContextMenuItem>
          <ContextMenuItem onSelect={onTimePrefix}>Set as TIME_PREFIX…</ContextMenuItem>
        </>
      )}
    </>
  );
}

/**
 * Event-level right-click menu: copy the whole event / its fields as JSON, and —
 * when text is selected — copy it or scaffold a props.conf directive from it.
 * Generated directives are upserted into the event's matched sourcetype stanza.
 *
 * `selectionText`, when provided (the Raw tab's React-controlled token selection),
 * takes precedence over the native window.getSelection fallback used elsewhere.
 *
 * `field`, when set, is a highlighted value the menu was opened on: the menu is
 * then that value's field menu. One menu per card serves every value in it.
 */
export function EventContextMenu({
  event,
  children,
  selectionText,
  selectionStart,
  field,
  onTogglePin,
}: {
  event: ViewEvent;
  children: ReactNode;
  selectionText?: string;
  selectionStart?: number;
  field?: FieldTarget | null;
  onTogglePin?: (field: string) => void;
}) {
  const { stanza, stanzaFor, apply: applyDirective } = useApplyDirective(event.metadata.sourcetype);

  // Capture the native selection when the menu opens — by the time an item's onSelect
  // fires, the menu has taken focus and window.getSelection() is usually empty. A
  // controlled selectionText (token selection) wins when present.
  const [nativeSelection, setNativeSelection] = useState('');
  const [extractOpen, setExtractOpen] = useState(false);
  const [timePrefixOpen, setTimePrefixOpen] = useState(false);

  const controlled = selectionText ?? '';
  const trimmedControlled = controlled.trim();
  const usingControlled = trimmedControlled.length > 0;
  const selection = usingControlled ? trimmedControlled : nativeSelection;

  // The controlled (token) selection carries its real offset in _raw, so the
  // scaffolded regex anchors on the exact occurrence the user picked rather than
  // the first match. Adjust for any leading whitespace removed by trim(). The
  // native-selection fallback has no reliable offset and stays on indexOf.
  const effectiveStart =
    usingControlled && selectionStart !== undefined
      ? selectionStart + (controlled.length - controlled.trimStart().length)
      : undefined;

  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          if (open) setNativeSelection(currentSelection());
        }}
      >
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          {field ? (
            <FieldMenuItems field={field.field} value={field.value} pinned={field.pinned} onTogglePin={onTogglePin} />
          ) : (
            <EventItems
              event={event}
              selection={selection}
              stanza={stanza}
              onExtract={() => setExtractOpen(true)}
              onTimePrefix={() => setTimePrefixOpen(true)}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>
      <ExtractNameDialog
        open={extractOpen}
        raw={event._raw}
        selection={selection}
        selectionStart={effectiveStart}
        stanza={stanza}
        onApply={(key, value) => applyDirective(key, value)}
        onClose={() => setExtractOpen(false)}
      />
      <TimePrefixDialog
        open={timePrefixOpen}
        raw={event._raw}
        selection={selection}
        selectionStart={effectiveStart}
        stanza={stanzaFor('TIME_PREFIX')}
        onApply={(value) => applyDirective('TIME_PREFIX', value)}
        onClose={() => setTimePrefixOpen(false)}
      />
    </>
  );
}
