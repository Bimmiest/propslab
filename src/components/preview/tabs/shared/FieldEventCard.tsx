import type { ReactNode } from 'react';
import type { ViewEvent } from '../../../../utils/viewResult';
import { HighlightedRaw } from './HighlightedRaw';
import { EventContextMenu } from './EventContextMenu';
import { EventCardHeader, EventNumber } from './EventCardHeader';

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
  return (
    <EventContextMenu event={event}>
      <div className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]">
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
          />
        </pre>
        {children}
      </div>
    </EventContextMenu>
  );
}
