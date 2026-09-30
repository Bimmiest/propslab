// ---------------------------------------------------------------------------
// groupNoOps.ts
// Collapse per-event no-op records into one row per directive.
//
// A config mistake is usually wrong for every event, so listing it once per
// event would bury the answer in the noise it exists to cut through. The event
// count is what separates "this is broken" from "this only applies to some
// events".
//
// Pure logic, kept out of the component so the component file exports only
// components (react-refresh) and so the grouping is testable on its own.
// ---------------------------------------------------------------------------

import type { DirectiveNoOp, SplunkEvent } from './types';
import { describeNoOp, noOpDirectiveKey } from './noOpExplainer';

export interface GroupedNoOp {
  directive: string;
  file: DirectiveNoOp['file'];
  line: number;
  phase: DirectiveNoOp['phase'];
  /** Distinct explanations seen for this directive, most common first. */
  reasons: { text: string; events: number }[];
  /**
   * Events past the run's explanation cap for this directive, which carry no
   * explanation. Counted apart from `reasons` so they never outnumber the real
   * ones into the headline.
   */
  notExplained: number;
  eventsAffected: number;
}

export function groupNoOps(events: readonly Pick<SplunkEvent, 'noOps'>[]): GroupedNoOp[] {
  const groups = new Map<string, GroupedNoOp & { seen: Map<string, number> }>();

  for (const event of events) {
    for (const noOp of event.noOps ?? []) {
      const key = noOpDirectiveKey(noOp);
      let group = groups.get(key);
      if (!group) {
        group = {
          directive: noOp.directive,
          file: noOp.file,
          line: noOp.line,
          phase: noOp.phase,
          reasons: [],
          notExplained: 0,
          eventsAffected: 0,
          seen: new Map<string, number>(),
        };
        groups.set(key, group);
      }
      group.eventsAffected++;
      if (noOp.reason.kind === 'not-explained') {
        group.notExplained++;
        continue;
      }
      const text = describeNoOp(noOp.reason);
      group.seen.set(text, (group.seen.get(text) ?? 0) + 1);
    }
  }

  return [...groups.values()].map(({ seen, ...group }) => ({
    ...group,
    reasons: [...seen.entries()].map(([text, events]) => ({ text, events })).sort((a, b) => b.events - a.events),
  }));
}
