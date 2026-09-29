import type { ReactNode } from 'react';
import type { ViewEvent } from '../../../../utils/viewResult';
import { HighlightedRaw } from './HighlightedRaw';
import { EventContextMenu } from './EventContextMenu';

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
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">Event #{globalIdx}</span>
        {badges}
      </div>
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
