import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import type { EnrichedEvent } from '../PreviewPanel';
import type { EventMetadata } from '../../../engine/types';
import type { ViewEvent } from '../../../utils/viewResult';
import { EventContextMenu } from './shared/EventContextMenu';
import { SelectableRaw, type RawSelection } from './shared/SelectableRaw';
import { Icon } from '../../ui/Icon';

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

interface MetadataChange {
  field: keyof EventMetadata;
  from: string;
  to: string;
  transform: string | null;
}

function getMetadataChanges(event: ViewEvent, original: EventMetadata | undefined): MetadataChange[] {
  const changes: MetadataChange[] = [];
  if (!original) return changes;
  for (const key of Object.keys(DEST_KEY_LABELS) as (keyof EventMetadata)[]) {
    if (event.metadata[key] !== original[key] && event.metadata[key] !== '') {
      // The step that last set this key, which wrote the value shown.
      const step = [...event.processingTrace].reverse().find(
        (s) => s.metadataChanges?.some((change) => change.key === key) ?? false,
      );
      const transform = step ? step.processor.split(':').pop() ?? null : null;
      changes.push({ field: key, from: original[key] || '(default)', to: event.metadata[key], transform });
    }
  }
  return changes;
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
  // The run's own input, as in PreviewPanel: the live fields may have been
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

function MetadataField({ label, value, original }: { label: string; value: string; original: string | undefined }) {
  const changed = original !== undefined && value !== original && value !== '';
  return (
    <span className="text-[var(--color-text-muted)]">
      {label}=<span className={changed ? 'text-[var(--color-warning)] font-semibold' : 'text-[var(--color-text-secondary)]'}>
        {value || '—'}
      </span>
    </span>
  );
}

function MetadataDetails({ event, originalMetadata, metadataChanges }: { event: ViewEvent; originalMetadata: EventMetadata | undefined; metadataChanges: MetadataChange[] }) {
  return (
    <>
      <div className="px-3 py-1.5 border-t border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs font-mono">
          <MetadataField label="index" value={event.metadata.index} original={originalMetadata?.index} />
          <MetadataField label="host" value={event.metadata.host} original={originalMetadata?.host} />
          <MetadataField label="source" value={event.metadata.source} original={originalMetadata?.source} />
          <MetadataField label="sourcetype" value={event.metadata.sourcetype} original={originalMetadata?.sourcetype} />
        </div>
      </div>

      {metadataChanges.length > 0 && (
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
                <Icon name="arrow-right" className="w-3 h-3 text-[var(--color-text-muted)] flex-shrink-0" />
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
  );
}

function ExpandLabel({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
      Show less
    </>
  ) : (
    <>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
      Show full event
    </>
  );
}

function EventRowHeader({ event, globalIdx, isDropped, hasMetadataChanges }: { event: ViewEvent; globalIdx: number; isDropped: boolean; hasMetadataChanges: boolean }) {
  const lineCount = event._raw.split('\n').length;
  const charCount = event._raw.length;

  const truncation = event.processingTrace.find((t) => t.truncation)?.truncation;

  return (
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
        {truncation && (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)] font-medium"
            title={`Truncated ${truncation.lines} ${truncation.lines === 1 ? 'line' : 'lines'} to ${truncation.limitBytes} bytes each (${truncation.isDefault ? 'TRUNCATE default' : `TRUNCATE=${truncation.limitBytes}`})`}
          >
            Truncated{truncation.isDefault ? ' (default)' : ''}
          </span>
        )}
        {/*
          A CLONE_SOURCETYPE copy is byte-identical to its original, so
          without saying where it came from a duplicated event reads as a
          line-breaking bug rather than the routing rule working.
        */}
        {event.clonedFrom !== undefined && (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-info)]/10 text-[var(--color-info)] font-medium"
            title={`Emitted by CLONE_SOURCETYPE from an event with sourcetype "${event.clonedFrom}"`}
          >
            Cloned from {event.clonedFrom}
          </span>
        )}
        {hasMetadataChanges && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)] font-medium">
            Metadata modified
          </span>
        )}
        {isDropped ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-error)]/10 text-[var(--color-error)] font-medium">
            Dropped
          </span>
        ) : event._meta._queue ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)] font-medium">
            Routed ({event._meta._queue})
          </span>
        ) : null}
      </div>
    </div>
  );
}

