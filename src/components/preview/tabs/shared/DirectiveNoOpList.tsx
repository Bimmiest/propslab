// ---------------------------------------------------------------------------
// DirectiveNoOpList.tsx
// "Why did this directive not fire?"
//
// Grouped by directive rather than listed per event: a config mistake is
// usually wrong for every event, and one row per event per directive would bury
// the answer in the noise it is meant to cut through. The event count is what
// distinguishes "this is broken" from "this only applies to some events".
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import type { DirectiveNoOp } from '../../../../engine/types';
import type { ViewEvent } from '../../../../utils/viewResult';
import { groupNoOps, type GroupedNoOp } from '../../../../engine/groupNoOps';
import { describeNoOp } from '../../../../engine/noOpExplainer';
import { revealInEditor } from '../../../editor/revealInEditor';
import { Icon } from '../../../ui/Icon';

function NoOpRow({ group, totalEvents }: { group: GroupedNoOp; totalEvents: number }) {
  const [expanded, setExpanded] = useState(false);
  const notExplained = describeNoOp({ kind: 'not-explained' });
  // One run always analyses a directive's first misses, so a group with no
  // real reason only arises from events merged across runs; say what we know.
  const primary = group.reasons[0]?.text ?? notExplained;

  return (
    <div className="border-b border-[var(--color-border-subtle)] last:border-b-0 px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon name="warning" className="w-3.5 h-3.5 text-[var(--color-warning)] shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs font-mono text-[var(--color-text-primary)]">{group.directive}</span>
            <span className="text-xs text-[var(--color-text-muted)]">
              no effect on {group.eventsAffected} of {totalEvents} event
              {totalEvents !== 1 ? 's' : ''}
            </span>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{primary}</p>
          {group.notExplained > 0 && group.reasons.length > 0 && (
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {notExplained} ({group.notExplained} more event{group.notExplained !== 1 ? 's' : ''})
            </p>
          )}
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <button
              type="button"
              onClick={() => revealInEditor(group.file, group.line)}
              className="text-xs font-mono text-[var(--color-accent)] cursor-pointer hover:underline bg-transparent border-none p-0"
            >
              {group.file}:{group.line}
            </button>
            {group.reasons.length > 1 && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
                className="text-xs text-[var(--color-accent)] cursor-pointer hover:underline bg-transparent border-none p-0"
              >
                {expanded ? 'Hide' : `${group.reasons.length - 1} other reason${group.reasons.length > 2 ? 's' : ''}`}
              </button>
            )}
          </div>
          {expanded && (
            <ul className="mt-1 space-y-0.5 pl-3">
              {group.reasons.slice(1).map((reason) => (
                <li key={reason.text} className="text-xs text-[var(--color-text-muted)]">
                  {reason.text} <span>({reason.events} events)</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function DirectiveNoOpList({
  events,
  phase,
}: {
  events: readonly ViewEvent[];
  /** Restrict to one pipeline half; omit for all. */
  phase?: DirectiveNoOp['phase'];
}) {
  const groups = useMemo(() => {
    const all = groupNoOps(events);
    return phase ? all.filter((g) => g.phase === phase) : all;
  }, [events, phase]);

  if (groups.length === 0) return null;

  return (
    <div className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]">
      <div className="px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">Did not fire ({groups.length})</span>
      </div>
      {groups.map((group) => (
        <NoOpRow key={`${group.file}:${group.line}:${group.directive}`} group={group} totalEvents={events.length} />
      ))}
    </div>
  );
}
