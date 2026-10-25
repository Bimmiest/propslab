import type { ReactNode } from 'react';

/**
 * The header row of a preview event card, which opens with an EventNumber.
 * The children sit in a row, or with `split` at the two edges. A card with
 * nothing below its header passes `border={false}`.
 */
export function EventCardHeader({
  split = false,
  border = true,
  children,
}: {
  split?: boolean;
  border?: boolean;
  children: ReactNode;
}) {
  const className = [
    'flex items-center',
    split ? 'justify-between' : 'gap-2',
    'px-3 py-1.5',
    border && 'border-b border-[var(--color-border)]',
    'bg-[var(--color-bg-tertiary)]',
  ]
    .filter(Boolean)
    .join(' ');
  return <div className={className}>{children}</div>;
}

/** "Event #N", N counted over the filtered events from 1; the children follow it inside the label. */
export function EventNumber({ globalIdx, children }: { globalIdx: number; children?: ReactNode }) {
  return (
    <span className="text-xs font-medium text-[var(--color-text-muted)]">
      Event #{globalIdx}
      {children}
    </span>
  );
}
