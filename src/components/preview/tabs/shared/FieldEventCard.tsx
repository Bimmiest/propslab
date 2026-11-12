import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { ViewEvent } from '../../../../utils/viewResult';
import { HighlightedRaw } from './HighlightedRaw';
import { EventContextMenu } from './EventContextMenu';
import { EventCardHeader, EventNumber } from './EventCardHeader';
import { fieldTargetOf, type FieldTarget } from './fieldSpans';

interface FieldEventCardProps {
  event: ViewEvent;
  globalIdx: number;
  badges: ReactNode;
  fieldColorMap: Map<string, string>;
  /** field name → value(s) to highlight in the raw text */
  fieldValues: Map<string, string | string[]>;
  titleFor: (field: string, value: string) => string;
  onFieldHover: (field: string | null) => void;
  onFieldClick: (field: string) => void;
  /** Maps stripped field name → original raw key for context-aware highlighting */
  fieldSourceKeys?: Record<string, string>;
  /** Authoritative offsets per field from positional extraction */
  fieldOffsets?: Record<string, Array<[number, number]>>;
  /** Optional footer content (e.g. key=value summary, Eval Expressions) */
  children?: ReactNode;
}

export function FieldEventCard({
  event,
  globalIdx,
  badges,
  fieldColorMap,
  fieldValues,
  titleFor,
  onFieldHover,
  onFieldClick,
  fieldSourceKeys,
  fieldOffsets,
  children,
}: FieldEventCardProps) {
  // The value a right-click or Shift+F10 landed on, read before the card's one
  // menu opens: its field menu then replaces the event menu.
  const [menuField, setMenuField] = useState<FieldTarget | null>(null);
  const hintId = useId();
  return (
    <EventContextMenu event={event} field={menuField} onTogglePin={onFieldClick}>
      <div
        className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]"
        onContextMenuCapture={(e) => setMenuField(fieldTargetOf(e.target, e.currentTarget))}
      >
        <EventCardHeader>
          <EventNumber globalIdx={globalIdx} />
          {badges}
        </EventCardHeader>
        <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all">
          <HighlightedRaw
            raw={event._raw}
            fieldColorMap={fieldColorMap}
            fieldValues={fieldValues}
            titleFor={titleFor}
            onFieldHover={onFieldHover}
            onFieldClick={onFieldClick}
            fieldSourceKeys={fieldSourceKeys}
            fieldOffsets={fieldOffsets}
            hintId={hintId}
          />
        </pre>
        {/* Outside the <pre>, so a copy of the event text does not take it. */}
        <span id={hintId} className="sr-only">
          Left and Right arrow keys move between the fields of the event. Enter pins the field. Shift+F10 or the Menu
          key opens its menu.
        </span>
        {children}
      </div>
    </EventContextMenu>
  );
}
