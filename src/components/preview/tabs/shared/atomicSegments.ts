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
  const byStart = highlights.map((_, i) => i).sort((a, b) => highlights[a]!.start - highlights[b]!.start || a - b);

  // Build atomic segments (owner = innermost covering highlight, or null for plain text),
  // merging contiguous runs that share the same owning field.
  const out: AtomicSegment[] = [];
  const open: number[] = [];
  let next = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i]!;
    const e = cuts[i + 1]!;
    while (next < byStart.length && highlights[byStart[next]!]!.start <= s) open.push(byStart[next++]!);
    // Segments only move right, so a highlight that ends before this one never covers another.
    let kept = 0;
    let ownerIdx = -1;
    for (const idx of open) {
      const h = highlights[idx]!;
      if (h.end < e) continue;
      open[kept++] = idx;
      const owner = ownerIdx < 0 ? null : highlights[ownerIdx]!;
      const len = h.end - h.start;
      if (owner === null || len < owner.end - owner.start || (len === owner.end - owner.start && idx < ownerIdx)) ownerIdx = idx;
    }
    open.length = kept;
    const owner = ownerIdx < 0 ? null : highlights[ownerIdx]!;
    const prev = out[out.length - 1];
    if (prev && prev.end === s && (prev.hl?.field ?? null) === (owner?.field ?? null)) {
      prev.end = e;
    } else {
      out.push({ start: s, end: e, hl: owner });
    }
  }
  return out;
}
