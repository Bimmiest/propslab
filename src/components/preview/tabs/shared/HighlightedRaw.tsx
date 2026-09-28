import { useMemo } from 'react';
import { findFieldValuePositions } from '../../../../utils/fieldHighlight';
import { useFieldFocusState } from './useFieldFocus';
import { copyQuietly } from '../../../../utils/clipboard';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuLabel } from '../../../ui/ContextMenu';

interface Highlight {
  start: number;
  end: number;
  field: string;
  color: string;
}

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
}

interface AtomicSegment {
  start: number;
  end: number;
  hl: Highlight | null;
}

/** Every span of `raw` a field's value occupies, coloured by field. */
function collectHighlights(
  raw: string,
  fieldColorMap: Map<string, string>,
  fieldValues: Map<string, string | string[]>,
  fieldSourceKeys: Record<string, string> | undefined,
  fieldOffsets: Record<string, Array<[number, number]>> | undefined,
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

/**
 * Split the raw text at every highlight boundary, then for each atomic sub-range
 * render the INNERMOST (smallest) field that covers it. This keeps overlapping /
 * nested field highlights additive — a field captured inside another still shows
 * its own colour — instead of the larger span swallowing the smaller one.
 */
function atomicSegments(raw: string, highlights: Highlight[]): AtomicSegment[] {
  if (highlights.length === 0) return [];

  const bounds = new Set<number>([0, raw.length]);
  for (const h of highlights) {
    if (h.start >= 0 && h.start <= raw.length) bounds.add(h.start);
    if (h.end >= 0 && h.end <= raw.length) bounds.add(h.end);
  }
  const cuts = [...bounds].sort((a, b) => a - b);

  // Build atomic segments (owner = innermost covering highlight, or null for plain text),
  // merging contiguous runs that share the same owning field.
  const out: AtomicSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i];
    const e = cuts[i + 1];
    if (s === undefined || e === undefined || s >= e) continue;
    let owner: Highlight | null = null;
    for (const h of highlights) {
      if (h.start <= s && h.end >= e && (owner === null || h.end - h.start < owner.end - owner.start)) {
        owner = h;
      }
    }
    const prev = out[out.length - 1];
    if (prev && prev.end === s && (prev.hl?.field ?? null) === (owner?.field ?? null)) {
      prev.end = e;
    } else {
      out.push({ start: s, end: e, hl: owner });
    }
  }
  return out;
}

/** Unhighlighted text, dimmed while any field is focused. */
function PlainSegment({ text }: { text: string }) {
  const focused = useFieldFocusState() !== 'none';
  return <span style={{ opacity: focused ? 0.3 : 1, transition: 'opacity 0.15s' }}>{text}</span>;
}

/** One highlighted field value, with its copy/pin context menu. */
function HighlightedSpan({
  hl,
  text,
  valueStr,
  title,
  onFieldHover,
  onFieldClick,
}: {
  hl: Highlight;
  text: string;
  valueStr: string;
  title: string;
  onFieldHover: (field: string | null) => void;
  onFieldClick: (field: string) => void;
}) {
  // Subscribed here rather than passed down, so a hover re-renders only the
  // spans whose look it changes, not every card on the page.
  const focusState = useFieldFocusState(hl.field);
  const focused = focusState !== 'none';
  const active = focusState !== 'dim';
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <span
          style={{
            color: hl.color,
            backgroundColor: active && focused ? hl.color + '20' : 'transparent',
            opacity: focused && !active ? 0.2 : 1,
            transition: 'opacity 0.15s, background-color 0.15s, color 0.15s',
            cursor: 'pointer',
          }}
          title={title}
          className="rounded-sm px-0.5"
          onMouseEnter={() => onFieldHover(hl.field)}
          onMouseLeave={() => onFieldHover(null)}
          onClick={() => onFieldClick(hl.field)}
        >
          {text}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{hl.field}</ContextMenuLabel>
        <ContextMenuItem onSelect={() => copyQuietly(valueStr)}>Copy value</ContextMenuItem>
        <ContextMenuItem onSelect={() => copyQuietly(hl.field)}>Copy field name</ContextMenuItem>
        <ContextMenuItem onSelect={() => copyQuietly(`${hl.field}=${valueStr}`)}>Copy field=value</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onFieldClick(hl.field)}>Pin / unpin field</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function HighlightedRaw({
  raw,
  fieldColorMap,
  fieldValues,
  titleFor,
  onFieldHover,
  onFieldClick,
  fieldSourceKeys,
  fieldOffsets,
}: HighlightedRawProps) {
  // Segmentation depends only on the raw text and the field/value/offset maps, so
  // it survives anything that re-renders the card without changing them.
  const atomic = useMemo(
    () => atomicSegments(raw, collectHighlights(raw, fieldColorMap, fieldValues, fieldSourceKeys, fieldOffsets)),
    [raw, fieldColorMap, fieldValues, fieldOffsets, fieldSourceKeys],
  );

  if (atomic.length === 0) {
    return <PlainSegment text={raw} />;
  }

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
        text={text}
        valueStr={valueStr}
        title={titleFor(hl.field, text)}
        onFieldHover={onFieldHover}
        onFieldClick={onFieldClick}
      />
    );
  });

  return <>{segments}</>;
}
