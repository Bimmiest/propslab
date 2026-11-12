import { memo, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { findFieldValuePositions } from '../../../../utils/fieldHighlight';
import { useFieldFocusState, useFieldSpanState } from './useFieldFocus';
import { tint } from '../../../../utils/tint';
import { atomicSegments, type Highlight } from './atomicSegments';
import { FIELD_SELECTOR, rovingIndex } from './fieldSpans';

interface HighlightedRawProps {
  raw: string;
  /** field name → hex color; only fields present in this map are highlighted */
  fieldColorMap: Map<string, string>;
  /** field name → value(s) to locate in the raw text */
  fieldValues: Map<string, string | string[]>;
  /** Returns the tooltip title for a highlighted span */
  titleFor: (field: string, value: string) => string;
  onFieldHover: (field: string | null) => void;
  onFieldClick: (field: string) => void;
  /** Maps stripped field name → original raw key (e.g. "GID" → "_GID") for context matching */
  fieldSourceKeys?: Record<string, string>;
  /**
   * Authoritative start/end offsets in `raw` per field (from positional extractions).
   * When present for a field, these offsets are used directly and context matching is skipped.
   */
  fieldOffsets?: Record<string, Array<[number, number]>>;
  /** The element that tells a screen reader the keys of the highlighted values. */
  hintId?: string;
}

/** Every span of `raw` a field's value occupies, coloured by field. */
function collectHighlights(
  raw: string,
  {
    fieldColorMap,
    fieldValues,
    fieldSourceKeys,
    fieldOffsets,
  }: Pick<HighlightedRawProps, 'fieldColorMap' | 'fieldValues' | 'fieldSourceKeys' | 'fieldOffsets'>,
): Highlight[] {
  const highlights: Highlight[] = [];

  for (const [field, color] of fieldColorMap) {
    const rawValue = fieldValues.get(field);
    if (rawValue === undefined) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];

    // Prefer authoritative offsets from positional extraction. Verify each offset
    // still matches one of the current field values — guards against later processors
    // that mutate _raw or the field value after EXTRACT runs.
    const offsetList = fieldOffsets?.[field];
    if (offsetList && offsetList.length > 0) {
      const valueSet = new Set(values.filter(Boolean));
      let usedAny = false;
      for (const [s, e] of offsetList) {
        if (s < 0 || e > raw.length || s >= e) continue;
        if (valueSet.has(raw.substring(s, e))) {
          highlights.push({ start: s, end: e, field, color });
          usedAny = true;
        }
      }
      if (usedAny) continue;
    }

    const originalKey = fieldSourceKeys?.[field];
    for (const v of values) {
      if (!v) continue;
      const positions = findFieldValuePositions(raw, field, v, originalKey);
      for (const idx of positions) {
        highlights.push({ start: idx, end: idx + v.length, field, color });
      }
    }
  }
  return highlights;
}

/** Unhighlighted text, dimmed while any field is focused. */
function PlainSegment({ text }: { text: string }) {
  const focused = useFieldFocusState() !== 'none';
  return <span style={{ opacity: focused ? 0.3 : 1, transition: 'opacity 0.15s' }}>{text}</span>;
}

/**
 * One highlighted field value. Its menu is the card's (EventContextMenu), which
 * reads the field and the value off `data-field` and `data-value`: one menu per
 * card, not one per value. Hover and focus focus the field; a press pins it.
 */
const HighlightedSpan = memo(function HighlightedSpan({
  hl,
  start,
  text,
  valueStr,
  title,
  tabbable,
  hintId,
  onFieldHover,
  onFieldClick,
}: {
  hl: Highlight;
  start: number;
  text: string;
  valueStr: string;
  title: string;
  /** The card's one tab stop among its values. */
  tabbable: boolean;
  hintId?: string;
  onFieldHover: (field: string | null) => void;
  onFieldClick: (field: string) => void;
}) {
  // Subscribed here rather than passed down, so a hover re-renders only the
  // spans whose look it changes, not every card on the page.
  const state = useFieldSpanState(hl.field);
  const focused = state !== 'none';
  const active = state !== 'dim';
  return (
    <span
      role="button"
      tabIndex={tabbable ? 0 : -1}
      aria-pressed={state === 'pinned'}
      aria-label={title}
      aria-describedby={hintId}
      data-field={hl.field}
      data-value={valueStr}
      data-start={start}
      style={{
        color: hl.color,
        backgroundColor: active && focused ? tint(hl.color, 13) : 'transparent',
        opacity: focused && !active ? 0.2 : 1,
        transition: 'opacity 0.15s, background-color 0.15s, color 0.15s',
        cursor: 'pointer',
      }}
      title={title}
      className="rounded-sm px-0.5"
      onMouseEnter={() => onFieldHover(hl.field)}
      onMouseLeave={() => onFieldHover(null)}
      onFocus={() => onFieldHover(hl.field)}
      onBlur={() => onFieldHover(null)}
      onClick={() => onFieldClick(hl.field)}
    >
      {text}
    </span>
  );
});

export function HighlightedRaw({
  raw,
  fieldColorMap,
  fieldValues,
  titleFor,
  onFieldHover,
  onFieldClick,
  fieldSourceKeys,
  fieldOffsets,
  hintId,
}: HighlightedRawProps) {
  // Segmentation depends only on the raw text and the field/value/offset maps, so
  // it survives anything that re-renders the card without changing them.
  const atomic = useMemo(
    () => atomicSegments(raw, collectHighlights(raw, { fieldColorMap, fieldValues, fieldSourceKeys, fieldOffsets })),
    [raw, fieldColorMap, fieldValues, fieldOffsets, fieldSourceKeys],
  );

  // A roving tab stop: Tab stops on one value per card, and the arrow keys
  // move between the values. Held by the value's offset in `raw`; the first
  // value when that value is gone or none was chosen.
  const [chosenStop, setTabStop] = useState<number | null>(null);
  const starts = atomic.flatMap(({ start, hl }) => (hl ? [start] : []));
  const tabStop = chosenStop !== null && starts.includes(chosenStop) ? chosenStop : starts[0];

  if (starts.length === 0) {
    return <PlainSegment text={raw} />;
  }

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const span = e.target;
    if (!(span instanceof HTMLElement)) return;
    const { field } = span.dataset;
    if (field === undefined) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onFieldClick(field);
      return;
    }
    const spans = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FIELD_SELECTOR));
    const next = rovingIndex(e.key, spans.indexOf(span), spans.length);
    const target = next === null ? undefined : spans[next];
    if (!target) return;
    e.preventDefault();
    setTabStop(Number(target.getAttribute('data-start')));
    target.focus();
  };

  const segments: React.ReactNode[] = atomic.map(({ start, end, hl }) => {
    const text = raw.substring(start, end);
    if (!hl) {
      return <PlainSegment key={`text-${start}`} text={text} />;
    }
    const raw0 = fieldValues.get(hl.field);
    const valueStr = raw0 === undefined ? text : Array.isArray(raw0) ? raw0.join(', ') : raw0;
    return (
      <HighlightedSpan
        key={`${start}-${hl.field}`}
        hl={hl}
        start={start}
        text={text}
        valueStr={valueStr}
        title={titleFor(hl.field, text)}
        tabbable={start === tabStop}
        hintId={hintId}
        onFieldHover={onFieldHover}
        onFieldClick={onFieldClick}
      />
    );
  });

  return <span onKeyDown={onKeyDown}>{segments}</span>;
}
