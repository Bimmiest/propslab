// ---------------------------------------------------------------------------
// DirectiveNoOpList.tsx
// "Why did this directive not fire?"
//
// Grouped by directive rather than listed per event: a config mistake is
// usually wrong for every event, and one row per event per directive would bury
// the answer in the noise it is meant to cut through. The event count is what
// distinguishes "this is broken" from "this only applies to some events", so
// only the first is a warning (#772): in a sourcetype with several log
// structures, most directives are written for one of them and miss the rest.
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import type { DirectiveNoOp } from '../../../../engine/types';
import type { ViewEvent } from '../../../../utils/viewResult';
import { groupNoOps, type GroupedNoOp } from '../../../../engine/groupNoOps';
import { describeNoOp } from '../../../../engine/noOpExplainer';
import { revealInEditor } from '../../../editor/revealInEditor';
import { Icon } from '../../../ui/Icon';

/**
 * One directive. A `partial` row, for a directive that fired on other events,
 * has no warning and keeps all of its reasons behind the toggle: they mostly
 * describe events of a structure the pattern was not written for.
 */
function NoOpRow({ group, totalEvents, partial }: { group: GroupedNoOp; totalEvents: number; partial: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const notExplained = describeNoOp({ kind: 'not-explained' });
  // One run always analyses a directive's first misses, so a group with no
  // real reason only arises from events merged across runs; say what we know.
  const primary = group.reasons[0]?.text ?? notExplained;
  const secondary = group.reasons.slice(1);
  const showPrimary = !partial || expanded;
  const toggleLabel = partial ? 'Why' : `${secondary.length} other reason${secondary.length > 1 ? 's' : ''}`;

  return (
    <div className="border-b border-[var(--color-border-subtle)] last:border-b-0 px-3 py-2">
      <div className="flex items-start gap-2">
        {!partial && <Icon name="warning" className="w-3.5 h-3.5 text-[var(--color-warning)] shrink-0 mt-0.5" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs font-mono text-[var(--color-text-primary)]">{group.directive}</span>
            <span className="text-xs text-[var(--color-text-muted)]">
              no effect on {group.eventsAffected} of {totalEvents} event
              {totalEvents !== 1 ? 's' : ''}
            </span>
          </div>
          {showPrimary && <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{primary}</p>}
          {showPrimary && group.notExplained > 0 && group.reasons.length > 0 && (
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
            {(partial || secondary.length > 0) && (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
                className="text-xs text-[var(--color-accent)] cursor-pointer hover:underline bg-transparent border-none p-0"
              >
                {expanded ? 'Hide' : toggleLabel}
              </button>
            )}
          </div>
          {expanded && secondary.length > 0 && (
            <ul className="motion-reveal mt-1 space-y-0.5 pl-3">
              {secondary.map((reason) => (
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
  const [showPartial, setShowPartial] = useState(false);

  if (groups.length === 0) return null;

  const never = groups.filter((g) => g.eventsAffected >= events.length);
  const partial = groups.filter((g) => g.eventsAffected < events.length);
  const rowKey = (g: GroupedNoOp) => `${g.file}:${g.line}:${g.directive}`;

  return (
    <div className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]">
      {never.length > 0 && (
        <>
          <div className="px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Did not fire ({never.length})</span>
          </div>
          {never.map((g) => (
            <NoOpRow key={rowKey(g)} group={g} totalEvents={events.length} partial={false} />
          ))}
        </>
      )}
      {partial.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowPartial(!showPartial)}
            aria-expanded={showPartial}
            className={`w-full flex items-center gap-1 px-3 py-1.5 text-left cursor-pointer border-[var(--color-border)] bg-[var(--color-bg-tertiary)] ${showPartial ? 'border-b' : ''}`}
          >
            <Icon
              name="chevron-down"
              className={`w-3 h-3 text-[var(--color-text-muted)] ${showPartial ? '' : '-rotate-90'}`}
            />
            <span className="text-xs font-medium text-[var(--color-text-muted)]">
              Fired on some events ({partial.length})
            </span>
          </button>
          {showPartial && partial.map((g) => <NoOpRow key={rowKey(g)} group={g} totalEvents={events.length} partial />)}
        </>
      )}
    </div>
  );
}
