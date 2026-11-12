import { memo, Suspense, useId, useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Tabs } from '../ui/Tabs';
import { tabId, tabPanelId } from '../ui/tabIds';
import { Icon } from '../ui/Icon';
import { retryableLazy } from '../ui/retryableLazy';
import type { OutputTabId } from '../../engine/types';
import { useDebounce } from '../../hooks/useDebounce';
import { EmptyState, FailureState } from './PreviewStates';
import { PreviewSubTab } from './PreviewSubTab';
import { usePipelineInputs } from './tabs/shared/usePipelineInputs';

// The output tabs other than Preview, out of the entry chunk (#566): each is
// mounted only when selected, so the cost is one chunk fetch on first open,
// and CIM Models brings its data table with it. Retryable, since that fetch
// can fail on a flaky network; the OutputBoundary around this panel offers the
// retry. A tab left open across a redeploy reloads instead (staleChunkReload.ts).
const CimModelsTab = retryableLazy(() => import('./tabs/CimModelsTab').then((m) => ({ default: m.CimModelsTab })));
const EffectiveConfigTab = retryableLazy(() =>
  import('./tabs/EffectiveConfigTab').then((m) => ({ default: m.EffectiveConfigTab })),
);
const FieldsTab = retryableLazy(() => import('./tabs/fields').then((m) => ({ default: m.FieldsTab })));
const TransformsTab = retryableLazy(() => import('./tabs/TransformsTab').then((m) => ({ default: m.TransformsTab })));
const ArchitecturePanel = retryableLazy(() =>
  import('../architecture/ArchitecturePanel').then((m) => ({ default: m.ArchitecturePanel })),
);

/**
 * How long a run must take before the output is covered with "Processing…".
 * Most runs take tens of milliseconds, and an overlay on each one only flashes.
 */
export const PROCESSING_OVERLAY_DELAY_MS = 150;

export const PreviewPanel = memo(function PreviewPanel() {
  const activeTab = useAppStore((s) => s.activeOutputTab);
  const setActiveTab = useAppStore((s) => s.setActiveOutputTab);
  const result = useAppStore((s) => s.processingResult);
  const isProcessing = useAppStore((s) => s.isProcessing);
  // Shown once a run has lasted PROCESSING_OVERLAY_DELAY_MS, hidden the moment it ends.
  const showOverlay = useDebounce(isProcessing, PROCESSING_OVERLAY_DELAY_MS) && isProcessing;
  const tabsId = useId();
  const diagnostics = useAppStore((s) => s.validationDiagnostics);
  // A run that produced no result at all — watchdog timeout, repeated worker
  // crash, an engine throw — clears `processingResult` and says why in an error
  // diagnostic. It is read here so such a run shows the failure, not the
  // first-run "No data yet" invitation to paste some input. A successful run
  // always sets a result, so a null result beside an error can only mean a
  // failure.
  const failure = result === null ? (diagnostics.find((d) => d.level === 'error')?.message ?? null) : null;
  const tabs = useMemo(
    () => [
      { id: 'preview', label: 'Preview' },
      { id: 'cim', label: 'CIM Models' },
      { id: 'fields', label: 'Fields' },
      { id: 'transforms', label: 'Pipeline' },
      { id: 'effective', label: 'Effective config' },
      { id: 'architecture', label: 'Architecture' },
    ],
    [],
  );

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-primary)]">
      {/* A container: in a narrow pane (a phone, or the two columns at about
          800 px) the label gives its room to the tabs, which the phone's own
          Output tab or the pane's place already names. */}
      <div className="@container flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
        <div className="@max-lg:hidden flex items-center gap-2 px-3 shrink-0">
          <Icon name="eye" className="w-3.5 h-3.5 text-[var(--color-accent)]" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
            Output
          </span>
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
        {/* Keyed so a new tab's content fades in; the tab mounts afresh on a switch anyway. */}
        <div key={activeTab} className="motion-fade-in h-full">
          <Suspense fallback={null}>
            <TabContent tab={activeTab} hasData={!!result && result.events.length > 0} failure={failure} />
          </Suspense>
        </div>
        {showOverlay && (
          <div
            className="motion-fade-in absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ backgroundColor: 'var(--color-bg-primary)', opacity: 0.6 }}
            aria-hidden="true"
          >
            <span className="text-xs text-[var(--color-text-muted)]">Processing…</span>
          </div>
        )}
      </div>
    </div>
  );
});

// Memoised so the processing overlay toggling on and off around every run does
// not re-render the tab beneath it.
const TabContent = memo(function TabContent({
  tab,
  hasData,
  failure,
}: {
  tab: OutputTabId;
  hasData: boolean;
  failure: string | null;
}) {
  const pipelineInputs = usePipelineInputs();
  if (tab === 'architecture') return <ArchitecturePanel inputs={pipelineInputs} embedded />;
  // Resolves the props.conf and metadata of the run on screen, so it has an
  // answer when the run produced no events — the same reason Architecture sits
  // above the gate rather than inside the switch.
  if (tab === 'effective') return <EffectiveConfigTab inputs={pipelineInputs} />;

  if (failure !== null) {
    return <FailureState message={failure} />;
  }

  if (!hasData) {
    return <EmptyState />;
  }

  switch (tab) {
    case 'preview':
      return <PreviewSubTab />;
    case 'cim':
      return <CimModelsTab />;
    case 'fields':
      return <FieldsTab />;
    case 'transforms':
      return <TransformsTab />;
    default:
      return null;
  }
});
