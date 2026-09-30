// ---------------------------------------------------------------------------
// atomicSegments.ts
// How HighlightedRaw cuts an event's text into runs, each drawn in the colour
// of the innermost field that covers it.
// ---------------------------------------------------------------------------

/** One span of the text a field's value occupies. */
export interface Highlight {
  start: number;
  end: number;
  field: string;
  color: string;
}

/** A highlight and its position in the list the caller passed. */
interface OpenHighlight {
  h: Highlight;
  index: number;
}

export interface AtomicSegment {
  start: number;
  end: number;
  hl: Highlight | null;
}

/**
 * Split the raw text at every highlight boundary, then for each atomic sub-range
 * render the INNERMOST (smallest) field that covers it. This keeps overlapping /
 * nested field highlights additive — a field captured inside another still shows
 * its own colour — instead of the larger span swallowing the smaller one. Of
 * two equally small, the one earlier in `highlights` wins.
 *
 * A sweep: highlights join the candidates as the cuts reach their start and
 * leave once a segment runs past their end, so each segment looks only at the
 * highlights open over it rather than at every highlight in the event.
 */
export function atomicSegments(raw: string, highlights: Highlight[]): AtomicSegment[] {
  if (highlights.length === 0) return [];

  const bounds = new Set<number>([0, raw.length]);
  for (const h of highlights) {
    if (h.start >= 0 && h.start <= raw.length) bounds.add(h.start);
    if (h.end >= 0 && h.end <= raw.length) bounds.add(h.end);
  }
  const cuts = [...bounds].sort((a, b) => a - b);
  // Each highlight travels with its position in `highlights`, which breaks a
  // tie between equally small owners in favour of the earlier one.
  const byStart: OpenHighlight[] = highlights
    .map((h, index) => ({ h, index }))
    .sort((a, b) => a.h.start - b.h.start || a.index - b.index);

  // Build atomic segments (owner = innermost covering highlight, or null for plain text),
  // merging contiguous runs that share the same owning field. The cuts include 0,
  // the smallest, so starting `s` there makes the first cut an empty segment to skip.
  const out: AtomicSegment[] = [];
  const open: OpenHighlight[] = [];
  let next = 0;
  let s = 0;
  for (const e of cuts) {
    if (e === s) continue;
    for (let entry = byStart[next]; entry !== undefined && entry.h.start <= s; entry = byStart[++next]) open.push(entry);
    // Segments only move right, so a highlight that ends before this one never covers another.
    let kept = 0;
    let owner: OpenHighlight | null = null;
    for (const entry of open) {
      const { h } = entry;
      if (h.end < e) continue;
      open[kept++] = entry;
      const len = h.end - h.start;
      if (owner === null || len < owner.h.end - owner.h.start || (len === owner.h.end - owner.h.start && entry.index < owner.index)) owner = entry;
    }
    open.length = kept;
    const hl = owner === null ? null : owner.h;
    const prev = out[out.length - 1];
    if (prev && prev.end === s && (prev.hl?.field ?? null) === (hl?.field ?? null)) {
      prev.end = e;
    } else {
      out.push({ start: s, end: e, hl });
    }
    s = e;
  }
  return out;
}
