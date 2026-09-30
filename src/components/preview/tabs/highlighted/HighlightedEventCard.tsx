// ---------------------------------------------------------------------------
// HighlightedEventCard.tsx
// One event on the Extractions tab: its text with each field highlighted,
// badged by category, with its calculated fields when those are shown.
// ---------------------------------------------------------------------------

import { memo, useMemo } from 'react';
import type { EnrichedEvent } from '../../enrichEvents';
import { FieldEventCard } from '../shared/FieldEventCard';
import { useFieldFocusState } from '../shared/useFieldFocus';
import { pressable } from '../../../ui/pressable';
import { tint } from '../../../../utils/tint';
import type { FieldCategories } from './fieldColoring';
import type { CalcField, EventBadges } from './eventRows';

interface FocusHandlers {
  pinnedFields: Set<string>;
  togglePin: (field: string) => void;
  setHoveredField: (field: string | null) => void;
}

/**
 * Memoised, and given no hover state: hover reaches the spans through
 * FieldFocusContext, so a card re-renders only when its event, the colours or
 * the pins change.
 */
export const HighlightedEventCard = memo(function HighlightedEventCard({
  item,
  globalIdx,
  badges,
  highlightColorMap,
  fieldColorMap,
  categories,
  pinnedFields,
  togglePin,
  setHoveredField,
}: {
  item: EnrichedEvent;
  globalIdx: number;
  badges: EventBadges;
  highlightColorMap: Map<string, string>;
  fieldColorMap: Map<string, string>;
  categories: FieldCategories;
} & FocusHandlers) {
  const { eventCalcFields, autoCount, manualCount, calcCount } = badges;
  const { manualFields, calcFields } = categories;
  // A new Map would defeat HighlightedRaw's segmentation memo on every render.
  const fieldValues = useMemo(
    () =>
      new Map<string, string | string[]>(Object.entries(item.event.fields).filter(([k]) => highlightColorMap.has(k))),
    [item.event.fields, highlightColorMap],
  );
  const focus = { pinnedFields, togglePin, setHoveredField };

  return (
    <FieldEventCard
      event={item.event}
      globalIdx={globalIdx}
      fieldColorMap={highlightColorMap}
      fieldValues={fieldValues}
      fieldSourceKeys={item.event.fieldSourceKeys}
      fieldOffsets={item.event.fieldOffsets}
      titleFor={(field, value) => {
        const tag = manualFields.has(field) ? 'manual' : calcFields.has(field) ? 'calc' : 'auto';
        return `${field} (${tag}): ${value}`;
      }}
      onFieldHover={setHoveredField}
      onFieldClick={togglePin}
      badges={
        <>
          {autoCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)]">
              {autoCount} auto
            </span>
          )}
          {manualCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
              {manualCount} manual
            </span>
          )}
          {calcCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)]">
              {calcCount} calc
            </span>
          )}
        </>
      }
    >
      {/* Calculated field summary strip + Eval Expressions (only when calc filter active) */}
      {eventCalcFields.length > 0 && (
        <>
          <div className="border-t border-[var(--color-border)] px-3 py-2">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {eventCalcFields.map((cf) => (
                <CalcFieldChip
                  key={cf.name}
                  cf={cf}
                  color={fieldColorMap.get(cf.name) ?? 'var(--color-text-muted)'}
                  focus={focus}
                />
              ))}
            </div>
          </div>
          <details className="border-t border-[var(--color-border)]">
            <summary className="px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] cursor-pointer select-none hover:text-[var(--color-text-secondary)] transition-colors">
              Eval Expressions
            </summary>
            <div className="px-3 py-2 border-t border-[var(--color-border)]">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {eventCalcFields.map((cf) => (
                  <CalcFieldChip
                    key={cf.name}
                    cf={cf}
                    color={fieldColorMap.get(cf.name) ?? 'var(--color-text-muted)'}
                    focus={focus}
                    showExpression
                  />
                ))}
              </div>
            </div>
          </details>
        </>
      )}
    </FieldEventCard>
  );
});

/**
 * A calculated field, as `name=value` in the summary strip or as its EVAL
 * expression in the details. Hovering focuses the field; pressing pins it.
 */
function CalcFieldChip({
  cf,
  color,
  focus,
  showExpression = false,
}: {
  cf: CalcField;
  color: string;
  focus: FocusHandlers;
  showExpression?: boolean;
}) {
  const { pinnedFields, setHoveredField, togglePin } = focus;
  const focusState = useFieldFocusState(cf.name);
  const focused = focusState !== 'none';
  const active = focusState !== 'dim';
  const pinned = pinnedFields.has(cf.name);
  const display = Array.isArray(cf.value) ? cf.value.join(', ') : cf.value;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-mono cursor-pointer select-none"
      style={{ opacity: focused && !active ? 0.2 : 1, transition: 'opacity 0.15s' }}
      onMouseEnter={() => setHoveredField(cf.name)}
      onMouseLeave={() => setHoveredField(null)}
      {...pressable(
        () => togglePin(cf.name),
        (f) => setHoveredField(f ? cf.name : null),
      )}
      aria-pressed={pinned}
    >
      {showExpression ? (
        <>
          <span style={{ color }} className="font-medium">
            {cf.name}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">expr</span>
          <code
            className="text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 rounded"
            style={{ outline: pinned ? `2px solid ${color}` : 'none', outlineOffset: '1px' }}
          >
            {cf.expression}
          </code>
        </>
      ) : (
        <>
          <span className="text-[var(--color-text-muted)]">{cf.name}=</span>
          <span
            className="px-1 py-0.5 rounded-sm max-w-48 truncate"
            style={{
              color,
              backgroundColor: active && focused ? tint(color, 13) : 'transparent',
              outline: pinned ? `2px solid ${color}` : 'none',
              outlineOffset: '1px',
              transition: 'background-color 0.15s, color 0.15s',
            }}
            title={display}
          >
            {display}
          </span>
        </>
      )}
    </span>
  );
}
