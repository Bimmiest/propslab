import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import type { EnrichedEvent } from '../enrichEvents';
import type { EventMetadata } from '../../../engine/types';
import { EventContextMenu } from './shared/EventContextMenu';
import { SelectableRaw, type RawSelection } from './shared/SelectableRaw';
import { SearchHighlightedRaw } from './shared/SearchHighlightedRaw';
import { MetadataDetails } from './raw/RawEventMetadata';
import { getMetadataChanges } from './raw/metadataChanges';
import { EventRowHeader, ExpandLabel } from './raw/RawEventHeader';

const MAX_COLLAPSED_HEIGHT = 300;

interface RawTabProps {
  items: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
  search: string;
}

/**
 * React keys for the page's rows: the event's source lines, which survive a
 * page change or a filter where a positional key would not. A
 * CLONE_SOURCETYPE copy keeps its original's lines and sits right after it,
 * so it adds the clone step it came from; anything still colliding (two
 * clones to the same sourcetype) takes an occurrence count.
 */
function rowKeys(items: EnrichedEvent[]): string[] {
  const seen = new Map<string, number>();
  return items.map(({ event }) => {
    const lines = `${event.lineNumbers.start}-${event.lineNumbers.end}`;
    const base = event.clonedFrom === undefined ? lines : `${lines}:${event.clonedFrom}>${event.metadata.sourcetype}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

export function RawTab({ items, currentPage, eventsPerPage, search }: RawTabProps) {
  // The run's own input, as in `enrichEvents`: the live fields may have been
  // edited since, which would badge every event as changed. Undefined only
  // with no result at all (the tab is not mounted then), when there is
  // nothing to compare against.
  const originalMetadata = useAppStore((s) => s.processingResult?.inputMetadata);
  const keys = useMemo(() => rowKeys(items), [items]);

  return (
    <div className="p-3 space-y-2">
      {items.map((item, idx) => {
        const globalIdx = (currentPage - 1) * eventsPerPage + idx + 1;
        return (
          <EventRow
            // Keyed by event, not its slot on the page (see rowKeys).
            // EventRow holds expand/selection state locally, so a positional key
            // let React reuse the instance across a page change or a filter that
            // altered membership — showing one event's expanded body, and its
            // text selection, on a different event.
            key={keys[idx]}
            item={item}
            globalIdx={globalIdx}
            originalMetadata={originalMetadata}
            search={search}
          />
        );
      })}
    </div>
  );
}

function EventRow({ item, globalIdx, originalMetadata, search }: { item: EnrichedEvent; globalIdx: number; originalMetadata: EventMetadata | undefined; search: string }) {
  const { event, isDropped } = item;
  const [expanded, setExpanded] = useState(false);

  const metadataChanges = useMemo(
    () => getMetadataChanges(event, originalMetadata),
    [event, originalMetadata]
  );

  const hasMetadataChanges = metadataChanges.length > 0;

  const [metaExpanded, setMetaExpanded] = useState(false);

  // React-controlled token selection (Raw view only; search uses the dimming
  // highlighter). The picked substring drives the scaffold-from-selection menu.
  // Held with the _raw it was made in: a re-run that rewrites the same
  // event's text keeps the row, and offsets into the old text would pick out
  // a different token in the new one.
  const [picked, setPicked] = useState<{ raw: string; sel: RawSelection } | null>(null);
  const selection = picked?.raw === event._raw ? picked.sel : null;
  const setSelection = (sel: RawSelection | null) => setPicked(sel ? { raw: event._raw, sel } : null);
  const searching = search.trim().length > 0;
  const hasTokenSelection = !searching && selection !== null;
  const selectedText = hasTokenSelection ? event._raw.slice(selection.start, selection.end) : '';
  // The token selection's real offset in _raw lets the scaffold anchor on the
  // exact occurrence picked (not the first match of the same text).
  const selectionStart = hasTokenSelection ? selection.start : undefined;

  const preRef = useRef<HTMLPreElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    if (expanded) return;
    const el = preRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [event._raw, search, expanded]);

  return (
    <EventContextMenu event={event} selectionText={selectedText} selectionStart={selectionStart}>
    <div
      className={`border rounded ${isDropped ? 'border-[var(--color-error)]/40' : 'border-[var(--color-border)]'} bg-[var(--color-bg-secondary)]`}
    >
      <EventRowHeader event={event} globalIdx={globalIdx} isDropped={isDropped} hasMetadataChanges={hasMetadataChanges} />

      <pre
        ref={preRef}
        // A dropped event is dimmed with the muted token, not opacity, which
        // would take the text below 4.5:1.
        className={`p-3 text-xs font-mono whitespace-pre-wrap break-all ${isDropped ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-primary)]'} overflow-x-auto`}
        style={{ maxHeight: expanded ? undefined : MAX_COLLAPSED_HEIGHT }}
      >
        {searching
          ? <SearchHighlightedRaw raw={event._raw} search={search} />
          : <SelectableRaw raw={event._raw} selection={selection} onChange={setSelection} />}
      </pre>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium border-t border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          style={{ color: 'var(--color-accent)' }}
        >
          <ExpandLabel expanded={expanded} />
        </button>
      )}

      {/* Metadata bar (collapsible) */}
      <button
        type="button"
        onClick={() => setMetaExpanded((v) => !v)}
        aria-expanded={metaExpanded}
        className="w-full flex items-center gap-2 px-3 py-1 border-t border-[var(--color-border)] bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-secondary)] transition-colors"
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform ${metaExpanded ? 'rotate-90' : ''}`}
          style={{ color: 'var(--color-text-muted)' }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-xs text-[var(--color-text-muted)]">Metadata</span>
      </button>

      {metaExpanded && (
        <MetadataDetails event={event} originalMetadata={originalMetadata} metadataChanges={metadataChanges} />
      )}
    </div>
    </EventContextMenu>
  );
}
