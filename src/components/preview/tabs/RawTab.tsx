import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import type { EnrichedEvent } from '../PreviewPanel';
import type { EventMetadata, SplunkEvent } from '../../../engine/types';
import { EventContextMenu } from './shared/EventContextMenu';
import { SelectableRaw, type RawSelection } from './shared/SelectableRaw';

const MAX_COLLAPSED_HEIGHT = 300;

interface RawTabProps {
  items: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
  search: string;
}

/** Map from metadata key to the DEST_KEY name used in transforms.conf */
const DEST_KEY_LABELS: Record<keyof EventMetadata, string> = {
  index: '_MetaData:Index',
  host: '_MetaData:Host',
  source: '_MetaData:Source',
  sourcetype: '_MetaData:Sourcetype',
};

function getMetadataChanges(event: SplunkEvent, original: EventMetadata) {
  const changes: { field: keyof EventMetadata; from: string; to: string; transform: string | null }[] = [];
  for (const key of Object.keys(DEST_KEY_LABELS) as (keyof EventMetadata)[]) {
    if (event.metadata[key] !== original[key] && event.metadata[key] !== '') {
      // Find the transform that caused this change
      const destKeyTarget = `MetaData:${key.charAt(0).toUpperCase() + key.slice(1)}`;
      const step = event.processingTrace.find(
        (s) => s.description.includes(destKeyTarget) || s.description.includes(DEST_KEY_LABELS[key])
      );
      const transform = step ? step.processor.split(':').pop() ?? null : null;
      changes.push({ field: key, from: original[key] || '(default)', to: event.metadata[key], transform });
    }
  }
  return changes;
}

export function RawTab({ items, currentPage, eventsPerPage, search }: RawTabProps) {
  // The run's own input, as in PreviewPanel: the live fields may have been
  // edited since, which would badge every event as changed (#316).
  const originalMetadata = useAppStore((s) => s.processingResult?.inputMetadata ?? s.metadata);

  return (
    <div className="p-3 space-y-2">
      {items.map((item, idx) => {
        const globalIdx = (currentPage - 1) * eventsPerPage + idx + 1;
        return (
          <EventRow
            // Keyed by the event's source lines, not its slot on the page.
            // EventRow holds expand/selection state locally, so a positional key
            // let React reuse the instance across a page change or a filter that
            // altered membership — showing one event's expanded body, and its
            // text selection, on a different event.
            key={`${item.event.lineNumbers.start}-${item.event.lineNumbers.end}`}
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

function EventRow({ item, globalIdx, originalMetadata, search }: { item: EnrichedEvent; globalIdx: number; originalMetadata: EventMetadata; search: string }) {
  const { event, isDropped } = item;
  const [expanded, setExpanded] = useState(false);

  const metadataChanges = useMemo(
    () => getMetadataChanges(event, originalMetadata),
    [event, originalMetadata]
  );

  const hasMetadataChanges = metadataChanges.length > 0;

  const lineCount = event._raw.split('\n').length;
  const charCount = event._raw.length;

  const truncateTrace = event.processingTrace.find((t) => t.processor === 'truncator');
  const truncatedByDefault = truncateTrace?.description.includes('TRUNCATE default') ?? false;

  const [metaExpanded, setMetaExpanded] = useState(false);

  // React-controlled token selection (Raw view only; search uses the dimming
  // highlighter). The picked substring drives the scaffold-from-selection menu.
  const [selection, setSelection] = useState<RawSelection | null>(null);
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
      className={`border rounded ${isDropped ? 'border-red-500/40 opacity-60' : 'border-[var(--color-border)]'} bg-[var(--color-bg-secondary)]`}
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-[var(--color-text-muted)]">
            Event #{globalIdx}
          </span>
          {event._time && (
            <span className="text-xs text-[var(--color-accent)] font-mono">
              {event._time.toISOString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-text-muted)] font-mono">
            {lineCount} line{lineCount !== 1 ? 's' : ''} &middot; {charCount.toLocaleString()} char{charCount !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-[var(--color-text-muted)]">
            Lines {event.lineNumbers.start}–{event.lineNumbers.end}
          </span>
          {truncateTrace && (
            <span
              className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/20 text-[var(--color-warning)] font-medium"
              title={truncateTrace.description}
            >
              Truncated{truncatedByDefault ? ' (default)' : ''}
            </span>
          )}
          {/*
            A CLONE_SOURCETYPE copy is byte-identical to its original, so
            without saying where it came from a duplicated event reads as a
            line-breaking bug rather than the routing rule working (#87).
          */}
          {event.clonedFrom !== undefined && (
            <span
              className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-info)]/20 text-[var(--color-info)] font-medium"
              title={`Emitted by CLONE_SOURCETYPE from an event with sourcetype "${event.clonedFrom}"`}
            >
              Cloned from {event.clonedFrom}
            </span>
          )}
          {hasMetadataChanges && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/20 text-[var(--color-warning)] font-medium">
              Metadata modified
            </span>
          )}
          {isDropped ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-medium">
              Dropped
            </span>
          ) : event._meta._queue ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-medium">
              Routed ({event._meta._queue})
            </span>
          ) : null}
        </div>
      </div>

      <pre
        ref={preRef}
        className="p-3 text-xs font-mono whitespace-pre-wrap break-all text-[var(--color-text-primary)] overflow-x-auto"
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
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium border-t border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
          style={{ color: 'var(--color-accent)' }}
        >
          {expanded ? (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
              Show less
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
              Show full event
            </>
          )}
        </button>
      )}

      {/* Metadata bar (collapsible) */}
      <button
        type="button"
        onClick={() => setMetaExpanded((v) => !v)}
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
        <>
          <div className="px-3 py-1.5 border-t border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs font-mono">
              <MetadataField label="index" value={event.metadata.index} original={originalMetadata.index} />
              <MetadataField label="host" value={event.metadata.host} original={originalMetadata.host} />
              <MetadataField label="source" value={event.metadata.source} original={originalMetadata.source} />
              <MetadataField label="sourcetype" value={event.metadata.sourcetype} original={originalMetadata.sourcetype} />
            </div>
          </div>

          {hasMetadataChanges && (
            <div className="px-3 py-1.5 border-t border-[var(--color-border)] bg-[var(--color-warning)]/5">
              <div className="space-y-1">
                {metadataChanges.map((change) => (
                  <div key={change.field} className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-medium text-[var(--color-warning)]">
                      {DEST_KEY_LABELS[change.field]}
                    </span>
                    <span className="font-mono text-[var(--color-text-muted)] line-through">
                      {change.from}
                    </span>
                    <svg className="w-3 h-3 text-[var(--color-text-muted)] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    <span className="font-mono font-semibold text-[var(--color-warning)]">
                      {change.to}
                    </span>
                    {change.transform && (
                      <span className="text-[var(--color-text-muted)]">
                        via <span className="font-mono text-[var(--color-accent)]">[{change.transform}]</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
    </EventContextMenu>
  );
}

function SearchHighlightedRaw({ raw, search }: { raw: string; search: string }) {
  const trimmed = search.trim().toLowerCase();

  if (!trimmed) return <>{raw}</>;

  const lines = raw.split('\n');

  return (
    <>
      {lines.map((line, lineIdx) => {
        const lowerLine = line.toLowerCase();
        const hasMatch = lowerLine.includes(trimmed);

        // Build line content with highlighted matches
        let content: React.ReactNode;
        if (hasMatch) {
          const segments: React.ReactNode[] = [];
          let cursor = 0;
          let searchIdx = lowerLine.indexOf(trimmed, cursor);
          while (searchIdx !== -1) {
            if (searchIdx > cursor) {
              segments.push(line.substring(cursor, searchIdx));
            }
            segments.push(
              <mark
                key={searchIdx}
                className="rounded-sm px-0.5"
                style={{
                  backgroundColor: 'var(--color-accent)',
                  color: 'var(--color-text-on-accent)',
                }}
              >
                {line.substring(searchIdx, searchIdx + trimmed.length)}
              </mark>
            );
            cursor = searchIdx + trimmed.length;
            searchIdx = lowerLine.indexOf(trimmed, cursor);
          }
          if (cursor < line.length) {
            segments.push(line.substring(cursor));
          }
          content = segments;
        } else {
          content = line;
        }

        return (
          <span
            key={lineIdx}
            style={{
              opacity: hasMatch ? 1 : 0.35,
              transition: 'opacity 0.15s',
            }}
          >
            {content}
            {lineIdx < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </>
  );
}

function MetadataField({ label, value, original }: { label: string; value: string; original: string }) {
  const changed = value !== original && value !== '';
  return (
    <span className="text-[var(--color-text-muted)]">
      {label}=<span className={changed ? 'text-[var(--color-warning)] font-semibold' : 'text-[var(--color-text-secondary)]'}>
        {value || '—'}
      </span>
    </span>
  );
}
