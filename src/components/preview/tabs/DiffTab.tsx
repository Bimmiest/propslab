import { useMemo } from 'react';
import { computeDiff } from '../../../utils/diffEngine';
import type { EnrichedEvent } from '../enrichEvents';
import { DiffLines } from '../../ui/DiffLines';

interface DiffTabProps {
  items: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
}

export function DiffTab({ items, currentPage, eventsPerPage }: DiffTabProps) {
  return (
    <div className="p-3 space-y-2">
      {items.map((item, idx) => {
        const globalIdx = (currentPage - 1) * eventsPerPage + idx + 1;

        if (!item.hasChanges) {
          return (
            <div
              key={idx}
              className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]"
            >
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-bg-tertiary)]">
                <span className="text-xs font-medium text-[var(--color-text-muted)]">
                  Event #{globalIdx}
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)]">
                  Unchanged
                </span>
              </div>
            </div>
          );
        }

        return <DiffEventCard key={idx} globalIdx={globalIdx} originalRaw={item.originalRaw} modifiedRaw={item.event._raw} />;
      })}
    </div>
  );
}

function DiffEventCard({ globalIdx, originalRaw, modifiedRaw }: { globalIdx: number; originalRaw: string; modifiedRaw: string }) {
  const diff = useMemo(() => computeDiff(originalRaw, modifiedRaw), [originalRaw, modifiedRaw]);

  return (
    <div className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">
          Event #{globalIdx}
        </span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)]">
          Modified
        </span>
      </div>
      <div className="text-xs font-mono leading-relaxed">
        <DiffLines diff={diff} />
      </div>
    </div>
  );
}
