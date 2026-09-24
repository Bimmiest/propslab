import { useId, useState, useMemo } from 'react';

const normalise = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');
import type React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Tabs } from '../ui/Tabs';
import { tabId, tabPanelId } from '../ui/tabIds';
import { Icon } from '../ui/Icon';
import type { EventMetadata, OutputTabId, PreviewSubTabId, SplunkEvent } from '../../engine/types';
import { SAMPLE_CONFIGS } from '../../engine/sampleData';
import { RawTab } from './tabs/RawTab';
import { HighlightedTab } from './tabs/HighlightedTab';
import { DiffTab } from './tabs/DiffTab';
import { TimestampTab } from './tabs/TimestampTab';
import { RegexTab } from './tabs/RegexTab';
import { CimModelsTab } from './tabs/CimModelsTab';
import { EffectiveConfigTab } from './tabs/EffectiveConfigTab';
import { FieldsTab } from './tabs/FieldsTab';
import { TransformsTab } from './tabs/TransformsTab';
import { ArchitecturePanel } from '../architecture/ArchitecturePanel';
import { PreviewFilterBar } from './PreviewFilterBar';
import { EventPagination } from './EventPagination';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';

export interface EnrichedEvent {
  event: SplunkEvent;
  originalRaw: string;
  hasChanges: boolean;
  hasMetadataChanges: boolean;
  isDropped: boolean;
}

function hasMetadataDiff(eventMeta: EventMetadata, originalMeta: EventMetadata): boolean {
  return (
    (eventMeta.index !== originalMeta.index && eventMeta.index !== '') ||
    (eventMeta.host !== originalMeta.host && eventMeta.host !== '') ||
    (eventMeta.source !== originalMeta.source && eventMeta.source !== '') ||
    (eventMeta.sourcetype !== originalMeta.sourcetype && eventMeta.sourcetype !== '')
  );
}

/** How long the preview search waits for typing to pause before filtering (#335). */
const SEARCH_DEBOUNCE_MS = 200;

const PREVIEW_SUB_TABS: { id: PreviewSubTabId; label: string }[] = [
  { id: 'raw', label: 'Raw' },
  { id: 'timestamp', label: 'Timestamp' },
  { id: 'highlighted', label: 'Extractions' },
  { id: 'diff', label: 'Diff' },
  { id: 'regex', label: 'Regex' },
];

export function PreviewPanel() {
  const activeTab = useAppStore((s) => s.activeOutputTab);
  const setActiveTab = useAppStore((s) => s.setActiveOutputTab);
  const result = useAppStore((s) => s.processingResult);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const tabsId = useId();
  const diagnostics = useAppStore((s) => s.validationDiagnostics);
  // A run that produced no result at all — watchdog timeout, repeated worker
  // crash, an engine throw — clears `processingResult` and says why in an error
  // diagnostic. Without reading that here the panel fell through to the
  // first-run "No data yet" invitation, which told a user whose input had just
  // hung the pipeline to go and paste some input (#294). A successful run always
  // sets a result, so a null result beside an error can only mean a failure.
  const failure = result === null
    ? diagnostics.find((d) => d.level === 'error')?.message ?? null
    : null;
  const tabs = useMemo(() => [
    { id: 'preview', label: 'Preview' },
    { id: 'cim', label: 'CIM Models' },
    { id: 'fields', label: 'Fields' },
    { id: 'transforms', label: 'Pipeline' },
    { id: 'effective', label: 'Effective config' },
    { id: 'architecture', label: 'Architecture' },
  ], []);

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-2 px-3 shrink-0">
          <Icon name="eye" className="w-3.5 h-3.5 text-[var(--color-accent)]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Output</span>
        </div>
        <Tabs
          idPrefix={tabsId}
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as OutputTabId)}
          ariaLabel="Output tabs"
        />
      </div>
      <div
        className="flex-1 min-h-0 overflow-auto relative"
        role="tabpanel"
        id={tabPanelId(tabsId, activeTab)}
        aria-labelledby={tabId(tabsId, activeTab)}
        aria-busy={isProcessing}
      >
        <TabContent tab={activeTab} hasData={!!result && result.events.length > 0} failure={failure} />
        {isProcessing && (
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ backgroundColor: 'var(--color-bg-primary)', opacity: 0.6 }}
            aria-hidden="true"
          >
            <span className="text-xs text-[var(--color-text-muted)]">Processing…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TabContent({ tab, hasData, failure }: { tab: OutputTabId; hasData: boolean; failure: string | null }) {
  if (tab === 'architecture') return <ArchitecturePanel embedded />;
  // Resolves props.conf against the configured metadata, so it has an answer
  // before any data has been processed — the same reason Architecture sits
  // above the gate rather than inside the switch.
  if (tab === 'effective') return <EffectiveConfigTab />;

  if (failure !== null) {
    return <FailureState message={failure} />;
  }

  if (!hasData) {
    return <EmptyState />;
  }

  switch (tab) {
    case 'preview': return <PreviewSubTab />;
    case 'cim': return <CimModelsTab />;
    case 'fields': return <FieldsTab />;
    case 'transforms': return <TransformsTab />;
    default: return null;
  }
}

const SAMPLE_ICONS: Record<string, React.ComponentProps<typeof Icon>['name']> = {
  'Apache Access Log': 'terminal',
  'Palo Alto Firewall': 'shield',
};

function FailureState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center" role="alert">
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center"
        style={{ backgroundColor: 'var(--color-bg-secondary)' }}
      >
        <Icon name="warning" className="w-7 h-7 text-[var(--color-error)]" />
      </div>
      <div>
        <p className="text-sm font-semibold text-[var(--color-text-primary)]">Processing failed</p>
        <p className="text-xs text-[var(--color-text-muted)] max-w-md mt-1">{message}</p>
      </div>
    </div>
  );
}

function EmptyState() {
  const setRawData = useAppStore((s) => s.setRawData);
  const setPropsConf = useAppStore((s) => s.setPropsConf);
  const setTransformsConf = useAppStore((s) => s.setTransformsConf);
  const setMetadata = useAppStore((s) => s.setMetadata);

  const loadExample = (idx: number) => {
    const sample = SAMPLE_CONFIGS[idx];
    if (!sample) return;
    setRawData(sample.rawData);
    setPropsConf(sample.propsConf);
    setTransformsConf(sample.transformsConf);
    setMetadata(sample.metadata);
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8 px-8 text-center">
      <div className="flex flex-col items-center gap-3">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ backgroundColor: 'var(--color-bg-secondary)' }}
        >
          <Icon name="eye" className="w-7 h-7 text-[var(--color-text-muted)]" />
        </div>
        <div>
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">No data yet</p>
          <p className="text-xs text-[var(--color-text-muted)] max-w-xs mt-1">
            Paste raw log data on the left, then write a sourcetype stanza in props.conf to simulate the pipeline.
          </p>
        </div>
      </div>

      <div className="w-full max-w-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-3">
          Or load an example
        </p>
        <div className="grid grid-cols-2 gap-3">
          {SAMPLE_CONFIGS.map((sample, idx) => {
            const iconName = SAMPLE_ICONS[sample.name] ?? 'document';
            return (
              <button
                key={sample.name}
                onClick={() => loadExample(idx)}
                className="group flex flex-col items-start gap-2 p-4 rounded-xl text-left
                  bg-[var(--color-bg-elevated)] border border-[var(--color-border)]
                  hover:border-[var(--color-accent)] hover:shadow-md hover:-translate-y-0.5
                  transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
                  style={{ backgroundColor: 'var(--color-bg-secondary)' }}
                >
                  <Icon
                    name={iconName}
                    className="w-4 h-4 text-[var(--color-accent)] group-hover:text-[var(--color-accent)]"
                  />
                </div>
                <div>
                  <p className="text-xs font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-accent)] transition-colors">
                    {sample.name}
                  </p>
                  <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
                    {sample.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PreviewSubTab() {
  const result = useAppStore((s) => s.processingResult);
  const events = useMemo(() => result?.events ?? [], [result]);
  const originalRaw = result?.originalRaw ?? '';

  const [subTab, setSubTab] = useState<PreviewSubTabId>('raw');
  const subTabsId = useId();
  const [search, setSearch] = useState('');
  // The input stays bound to `search`, so typing is immediate; everything the
  // filter drives reads this settled copy. Each keystroke used to rebuild
  // `filteredEvents`, which re-scans every event, re-runs the Extractions tab's
  // JSON scan and re-posts the whole dataset to the Regex tab's matcher (#335).
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [selectedStatus, setSelectedStatus] = useState<Set<string>>(new Set());
  const [selectedChangeState, setSelectedChangeState] = useState<Set<string>>(new Set());

  // The metadata of the run that produced these events, not the live fields:
  // comparing with the fields flagged every event as modified while the user
  // typed, and rebuilt the event lists on each keystroke (#316).
  const originalMetadata = result?.inputMetadata;

  // Enrich events with original raw + change/drop status
  const enrichedEvents = useMemo(() => {
    const origLines = originalRaw.split('\n');
    return events.map((event): EnrichedEvent => {
      const startIdx = Math.max(0, event.lineNumbers.start - 1);
      const endIdx = event.lineNumbers.end;
      const origSlice = origLines.slice(startIdx, endIdx).join('\n');
      return {
        event,
        originalRaw: origSlice,
        hasChanges: normalise(origSlice) !== normalise(event._raw),
        hasMetadataChanges: originalMetadata !== undefined && hasMetadataDiff(event.metadata, originalMetadata),
        isDropped: event._meta._queue === 'nullQueue',
      };
    });
  }, [events, originalRaw, originalMetadata]);

  // Collect all field names across events
  const allFields = useMemo(() => {
    const fieldSet = new Set<string>();
    for (const { event } of enrichedEvents) {
      for (const key of Object.keys(event.fields)) {
        fieldSet.add(key);
      }
    }
    return Array.from(fieldSet).sort();
  }, [enrichedEvents]);

  // Apply filters
  const filteredEvents = useMemo(() => {
    return enrichedEvents.filter((item) => {
      if (debouncedSearch) {
        const lower = debouncedSearch.toLowerCase();
        if (!item.event._raw.toLowerCase().includes(lower)) return false;
      }
      if (selectedFields.size > 0) {
        const eventFieldKeys = Object.keys(item.event.fields);
        if (!eventFieldKeys.some((k) => selectedFields.has(k))) return false;
      }
      if (selectedStatus.size > 0) {
        if (selectedStatus.has('Dropped') && !selectedStatus.has('Accepted') && !item.isDropped) return false;
        if (selectedStatus.has('Accepted') && !selectedStatus.has('Dropped') && item.isDropped) return false;
      }
      if (selectedChangeState.size > 0) {
        const wantRaw = selectedChangeState.has('Raw Modified');
        const wantMeta = selectedChangeState.has('Metadata Modified');
        const wantUnmodified = selectedChangeState.has('Unmodified');
        const matchesRaw = item.hasChanges;
        const matchesMeta = item.hasMetadataChanges;
        const matchesUnmodified = !item.hasChanges && !item.hasMetadataChanges;
        const matches = (wantRaw && matchesRaw) || (wantMeta && matchesMeta) || (wantUnmodified && matchesUnmodified);
        if (!matches) return false;
      }
      return true;
    });
  }, [enrichedEvents, debouncedSearch, selectedFields, selectedStatus, selectedChangeState]);

  const { paginatedItems, currentPage, totalPages, eventsPerPage, totalItems, setCurrentPage, setEventsPerPage } =
    usePagination(filteredEvents);

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tab bar */}
      <div className="flex-shrink-0 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
        <Tabs
          idPrefix={subTabsId}
          tabs={PREVIEW_SUB_TABS}
          activeTab={subTab}
          onTabChange={(id) => setSubTab(id as PreviewSubTabId)}
          ariaLabel="Event preview sub-tabs"
          size="sm"
          variant="secondary"
        />
      </div>

      {/* Shared filter bar */}
      <PreviewFilterBar
        search={search}
        onSearchChange={(v) => { setSearch(v); setCurrentPage(1); }}
        allFields={allFields}
        selectedFields={selectedFields}
        onFieldsChange={(f) => { setSelectedFields(f); setCurrentPage(1); }}
        selectedStatus={selectedStatus}
        onStatusChange={(s) => { setSelectedStatus(s); setCurrentPage(1); }}
        selectedChangeState={selectedChangeState}
        onChangeStateChange={(m) => { setSelectedChangeState(m); setCurrentPage(1); }}
        filteredCount={filteredEvents.length}
        totalCount={enrichedEvents.length}
      />

      {/* Sub-tab content */}
      <div
        className="flex-1 min-h-0 overflow-auto"
        role="tabpanel"
        id={tabPanelId(subTabsId, subTab)}
        aria-labelledby={tabId(subTabsId, subTab)}
      >
        {subTab === 'raw' && <RawTab items={paginatedItems} currentPage={currentPage} eventsPerPage={eventsPerPage} search={debouncedSearch} />}
        {subTab === 'highlighted' && <HighlightedTab items={paginatedItems} allEvents={filteredEvents} currentPage={currentPage} eventsPerPage={eventsPerPage} />}
        {subTab === 'diff' && <DiffTab items={paginatedItems} currentPage={currentPage} eventsPerPage={eventsPerPage} />}
        {subTab === 'timestamp' && <TimestampTab items={paginatedItems} currentPage={currentPage} eventsPerPage={eventsPerPage} />}
        {subTab === 'regex' && <RegexTab items={paginatedItems} allEvents={filteredEvents} currentPage={currentPage} eventsPerPage={eventsPerPage} />}
      </div>

      {/* Shared pagination */}
      {totalItems > eventsPerPage && (
        <EventPagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalItems}
          eventsPerPage={eventsPerPage}
          onPageChange={setCurrentPage}
          onEventsPerPageChange={setEventsPerPage}
        />
      )}
    </div>
  );
}
