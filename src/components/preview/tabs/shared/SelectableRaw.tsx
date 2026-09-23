import { useEffect, useId, useMemo, useRef } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { tokenizeRaw, type RawSegment } from './tokenizeRaw';

export interface RawSelection {
  start: number;
  end: number;
}

const SELECTED_STYLE = {
  backgroundColor: 'var(--color-accent)',
  color: 'var(--color-text-on-accent)',
} as const;

/**
 * Character offset of a DOM boundary within `container`, measured by the length of
 * the text from the container's start up to the boundary. Because the rendered text
 * equals `raw` exactly (segments concatenate to the input), this is the raw offset.
 */
function charOffset(container: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** Map a viewport point to a raw character offset via caret hit-testing. */
function offsetFromPoint(container: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let off = 0;
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) { node = pos.offsetNode; off = pos.offset; }
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; off = r.startOffset; }
  }
  if (!node || !container.contains(node)) return null;
  return charOffset(container, node, off);
}

/**
 * Renders raw event text as a fully React-controlled selection. Native text
 * selection is disabled (`select-none`) so there is no system-blue highlight and no
 * reliance on window.getSelection (which the context menu clears on open) — the drag
 * is tracked from mouse coordinates instead. Click a token to select it, shift-click
 * to extend, click it again (or click whitespace) to clear, or drag across the text:
 * the range is snapped out to the tokens it touches and every segment in between
 * (tokens and gaps) is filled, so the highlight is one continuous block.
 *
 * The same selection is reachable from the keyboard (#300). The text is a
 * focusable read-only textbox: Left/Right (or Home/End) select a token, Shift
 * extends to the next one, Escape clears, Ctrl/Cmd+C copies it, and the Menu key
 * or Shift+F10 — which the browser delivers as a `contextmenu` event on the
 * focused element — opens the row's existing menu, its "Scaffold from
 * selection" items (Create EXTRACT…, Set as TIME_PREFIX…) included. Native selection stays off rather than being restored:
 * it would bring back exactly what the design removed (the menu clearing it,
 * ranges that end mid-token), and copy is provided for the controlled selection
 * instead.
 */
export function SelectableRaw({
  raw,
  selection,
  onChange,
}: {
  raw: string;
  selection: RawSelection | null;
  onChange: (sel: RawSelection | null) => void;
}) {
  const segments = useMemo(() => tokenizeRaw(raw), [raw]);
  const tokens = useMemo(() => segments.filter((s) => s.selectable), [segments]);
  const containerRef = useRef<HTMLSpanElement>(null);
  const hintId = useId();

  // A drag outlives the render that started it, so its window listeners read
  // the latest props through refs. Closed over directly, `up` saw the selection
  // and segments of the render the mousedown happened in — shift-click extended
  // from a stale anchor if the event re-rendered mid-drag. Written in an effect,
  // not during render, as react-hooks/refs requires.
  const latest = useRef({ selection, segments, onChange });
  useEffect(() => {
    latest.current = { selection, segments, onChange };
  });

  // Removes the in-flight drag's listeners. Held so an unmount mid-drag (a
  // page change, a filter, the event disappearing) can detach them; otherwise
  // they stayed on window and called onChange on an unmounted row.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);

  const snapToTokens = (lo: number, hi: number): RawSelection | null => {
    let start = lo;
    let end = hi;
    let touched = false;
    for (const s of latest.current.segments) {
      if (s.selectable && s.start < hi && s.end > lo) {
        start = Math.min(start, s.start);
        end = Math.max(end, s.end);
        touched = true;
      }
    }
    return touched ? { start, end } : null;
  };

  const onMouseDown = (e: ReactMouseEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return; // ignore right/middle — right-click opens the menu
    const container = containerRef.current;
    if (!container) return;
    const anchor = offsetFromPoint(container, e.clientX, e.clientY);
    if (anchor == null) return;
    e.preventDefault(); // no native caret/selection
    // preventDefault also cancels the focus a mousedown would give, which would
    // leave a mouse-made selection unreachable to the keys above.
    container.focus({ preventScroll: true });

    endDragRef.current?.();
    let moved = false;
    const move = (ev: MouseEvent) => {
      const cur = offsetFromPoint(container, ev.clientX, ev.clientY);
      if (cur == null) return;
      const lo = Math.min(anchor, cur);
      const hi = Math.max(anchor, cur);
      if (hi > lo) {
        moved = true;
        latest.current.onChange(snapToTokens(lo, hi));
      }
    };
    const up = (ev: MouseEvent) => {
      endDrag();
      if (moved) return; // a drag was already applied live in `move`
      // No drag → treat as a click: select / toggle / extend the token under it.
      const { selection: sel, segments: segs, onChange: emit } = latest.current;
      const seg = segs.find((s) => s.selectable && anchor >= s.start && anchor < s.end);
      if (!seg) { emit(null); return; }
      if (ev.shiftKey && sel) {
        emit({ start: Math.min(sel.start, seg.start), end: Math.max(sel.end, seg.end) });
      } else if (sel && sel.start === seg.start && sel.end === seg.end) {
        emit(null);
      } else {
        emit({ start: seg.start, end: seg.end });
      }
    };
    const endDrag = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      endDragRef.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    endDragRef.current = endDrag;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (tokens.length === 0) return;
    if (e.key === 'Escape') {
      if (selection) { e.preventDefault(); onChange(null); }
      return;
    }
    const forward = e.key === 'ArrowRight' || e.key === 'End';
    const backward = e.key === 'ArrowLeft' || e.key === 'Home';
    if (!forward && !backward) return;
    e.preventDefault();

    let target: RawSegment | undefined;
    if (e.key === 'Home') target = tokens[0];
    else if (e.key === 'End') target = tokens[tokens.length - 1];
    else if (!selection) target = forward ? tokens[0] : tokens[tokens.length - 1];
    else if (forward) target = tokens.find((t) => t.start >= selection.end) ?? tokens[tokens.length - 1];
    else target = [...tokens].reverse().find((t) => t.end <= selection.start) ?? tokens[0];
    if (!target) return;

    if (e.shiftKey && selection) {
      onChange({ start: Math.min(selection.start, target.start), end: Math.max(selection.end, target.end) });
    } else {
      onChange({ start: target.start, end: target.end });
    }
  };

  // Ctrl/Cmd+C. With native selection off there is nothing for the browser to
  // copy, so the controlled selection is put on the clipboard instead.
  const onCopy = (e: ReactClipboardEvent<HTMLSpanElement>) => {
    if (!selection) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', raw.slice(selection.start, selection.end));
  };

  const selectedText = selection ? raw.slice(selection.start, selection.end) : '';

  return (
    <>
      <span
        ref={containerRef}
        className="select-none rounded-sm"
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        aria-label="Event text"
        aria-describedby={hintId}
        tabIndex={0}
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
        onCopy={onCopy}
      >
        {segments.map((seg) => {
          const selected = selection != null && seg.start >= selection.start && seg.end <= selection.end;
          if (!seg.selectable) {
            return <span key={seg.start} style={selected ? SELECTED_STYLE : undefined}>{seg.text}</span>;
          }
          return (
            <span
              key={seg.start}
              className={`cursor-pointer rounded-sm ${selected ? '' : 'hover:bg-[var(--color-bg-tertiary)]'}`}
              style={selected ? SELECTED_STYLE : undefined}
            >
              {seg.text}
            </span>
          );
        })}
      </span>
      {/* The highlight is a background colour, which a screen reader cannot
          see; this says what the arrow keys just selected. */}
      {/* aria-describedby rather than aria-description: the latter is ARIA
          1.3 and not yet announced everywhere. */}
      <span id={hintId} className="sr-only">
        Arrow keys select a token, Shift extends, Escape clears. Shift+F10 or the Menu key opens actions for the selection.
      </span>
      <span className="sr-only" aria-live="polite">
        {selectedText ? `Selected: ${selectedText}` : ''}
      </span>
    </>
  );
}
