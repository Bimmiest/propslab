import { useMemo, useState } from 'react';
import { computeDiff } from '../../../utils/diffEngine';
import type { EnrichedEvent } from '../enrichEvents';
import { DiffLines } from '../../ui/DiffLines';
import { pageStart } from '../../../utils/pagination';
import { EventCardHeader, EventNumber } from './shared/EventCardHeader';
import { copyQuietly } from '../../../utils/clipboard';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../ui/ContextMenu';

interface DiffTabProps {
  items: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
}

export function DiffTab({ items, currentPage, eventsPerPage }: DiffTabProps) {
  return (
    <div className="p-3 space-y-2">
      {items.map((item, idx) => {
        const globalIdx = pageStart(currentPage, eventsPerPage) + idx + 1;

        if (!item.hasChanges) {
          return (
            <div key={idx} className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]">
              <EventCardHeader border={false}>
                <EventNumber globalIdx={globalIdx} />
                <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)]">
                  Unchanged
                </span>
              </EventCardHeader>
            </div>
          );
        }

        return (
          <DiffEventCard key={idx} globalIdx={globalIdx} originalRaw={item.originalRaw} modifiedRaw={item.event._raw} />
        );
      })}
    </div>
  );
}

function DiffEventCard({
  globalIdx,
  originalRaw,
  modifiedRaw,
}: {
  globalIdx: number;
  originalRaw: string;
  modifiedRaw: string;
}) {
  const diff = useMemo(() => computeDiff(originalRaw, modifiedRaw), [originalRaw, modifiedRaw]);
  // The line under the pointer when the menu opened (#761); read from the
  // event, since the menu cannot see what was right-clicked.
  const [line, setLine] = useState<string | null>(null);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]"
          onContextMenu={(e) => {
            const row = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-diff-line]') : null;
            setLine(row?.dataset['diffLine'] ?? null);
          }}
        >
          <EventCardHeader>
            <EventNumber globalIdx={globalIdx} />
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)]">
              Modified
            </span>
          </EventCardHeader>
          <div className="text-xs font-mono leading-relaxed">
            <DiffLines diff={diff} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {line !== null && <ContextMenuItem onSelect={() => copyQuietly(line)}>Copy the line</ContextMenuItem>}
        <ContextMenuItem onSelect={() => copyQuietly(originalRaw)}>Copy the event before</ContextMenuItem>
        <ContextMenuItem onSelect={() => copyQuietly(modifiedRaw)}>Copy the event after</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
