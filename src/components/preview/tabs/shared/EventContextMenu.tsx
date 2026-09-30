import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ViewEvent } from '../../../../utils/viewResult';
import { copyQuietly } from '../../../../utils/clipboard';
import { useApplyDirective } from './useApplyDirective';
import { ExtractNameDialog } from './ExtractNameDialog';
import { TimePrefixDialog } from './TimePrefixDialog';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from '../../../ui/ContextMenu';

function currentSelection(): string {
  return (typeof window !== 'undefined' ? (window.getSelection()?.toString() ?? '') : '').trim();
}

/**
 * Event-level right-click menu: copy the whole event / its fields as JSON, and —
 * when text is selected — copy it or scaffold a props.conf directive from it.
 * Generated directives are upserted into the event's matched sourcetype stanza.
 *
 * `selectionText`, when provided (the Raw tab's React-controlled token selection),
 * takes precedence over the native window.getSelection fallback used elsewhere.
 */
export function EventContextMenu({
  event,
  children,
  selectionText,
  selectionStart,
}: {
  event: ViewEvent;
  children: ReactNode;
  selectionText?: string;
  selectionStart?: number;
}) {
  const { stanza, apply: applyDirective } = useApplyDirective();

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
          <ContextMenuItem onSelect={() => copyQuietly(event._raw)}>Copy event</ContextMenuItem>
          {Object.keys(event.fields).length > 0 && (
            <ContextMenuItem onSelect={() => copyQuietly(JSON.stringify(event.fields, null, 2))}>
              Copy fields as JSON
            </ContextMenuItem>
          )}
          {selection.length > 0 && (
            <>
              <ContextMenuItem onSelect={() => copyQuietly(selection)}>Copy selection</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuLabel>Scaffold from selection → [{stanza}]</ContextMenuLabel>
              <ContextMenuItem onSelect={() => setExtractOpen(true)}>Create EXTRACT…</ContextMenuItem>
              <ContextMenuItem onSelect={() => setTimePrefixOpen(true)}>Set as TIME_PREFIX…</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {extractOpen && (
        <ExtractNameDialog
          raw={event._raw}
          selection={selection}
          selectionStart={effectiveStart}
          stanza={stanza}
          onApply={(key, value) => applyDirective(key, value)}
          onClose={() => setExtractOpen(false)}
        />
      )}
      {timePrefixOpen && (
        <TimePrefixDialog
          raw={event._raw}
          selection={selection}
          selectionStart={effectiveStart}
          stanza={stanza}
          onApply={(value) => applyDirective('TIME_PREFIX', value)}
          onClose={() => setTimePrefixOpen(false)}
        />
      )}
    </>
  );
}
