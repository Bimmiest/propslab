import { createContext, memo, useContext, useId, useMemo, type ReactNode } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Tabs } from '../ui/Tabs';
import { tabId, tabPanelId } from '../ui/tabIds';
import { Icon } from '../ui/Icon';
import type { OutputTabId } from '../../engine/types';
import { CimModelsTab } from './tabs/CimModelsTab';
import { EffectiveConfigTab } from './tabs/EffectiveConfigTab';
import { FieldsTab } from './tabs/fields';
import { TransformsTab } from './tabs/TransformsTab';
import { ArchitecturePanel } from '../architecture/ArchitecturePanel';
import { useDebounce } from '../../hooks/useDebounce';
import { EmptyState, FailureState } from './PreviewStates';
import { PreviewSubTab } from './PreviewSubTab';
import { usePipelineInputs, type PipelineInputs } from './tabs/shared/usePipelineInputs';

/**
 * How long a run must take before the output is covered with "Processing…".
 * Most runs take tens of milliseconds, and an overlay on each one only flashes.
 */
export const PROCESSING_OVERLAY_DELAY_MS = 150;

const PipelineInputsContext = createContext<PipelineInputs | null>(null);

/**
 * Holds the last run's inputs for the tabs below. Held here rather than in the
 * Effective config tab, which unmounts when another output tab is selected: in
 * manual-apply mode the inputs of the last run have to survive the edits made
 * while it is hidden.
 *
 * A component of its own because usePipelineInputs subscribes to props.conf:
 * called in PreviewPanel, every keystroke re-rendered the whole output. Here
 * only this provider re-renders; `children` is the same element each time, so
 * React skips it until the settled inputs themselves change.
 */
function PipelineInputsProvider({ children }: { children: ReactNode }) {
  const pipelineInputs = usePipelineInputs();
  return <PipelineInputsContext.Provider value={pipelineInputs}>{children}</PipelineInputsContext.Provider>;
}

function usePipelineInputsContext(): PipelineInputs {
  const inputs = useContext(PipelineInputsContext);
  if (!inputs) throw new Error('usePipelineInputsContext outside PipelineInputsProvider');
  return inputs;
}

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
        <PipelineInputsProvider>
          <TabContent
            tab={activeTab}
            hasData={!!result && result.events.length > 0}
            failure={failure}
          />
        </PipelineInputsProvider>
        {showOverlay && (
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
});

// Memoised so the processing overlay toggling on and off around every run does
// not re-render the tab beneath it.
const TabContent = memo(function TabContent({ tab, hasData, failure }: {
  tab: OutputTabId;
  hasData: boolean;
  failure: string | null;
}) {
  const pipelineInputs = usePipelineInputsContext();
  // What the preview's tabs read of the inputs, kept by identity while those
  // parts are unchanged, so an edit that only the Architecture tab reads (in
  // transforms.conf) does not re-render the preview beneath it.
  const { propsConf, metadata } = pipelineInputs;
  const previewInputs = useMemo(() => ({ propsConf, metadata }), [propsConf, metadata]);
  if (tab === 'architecture') return <ArchitecturePanel inputs={pipelineInputs} embedded />;
  // Resolves the last run's props.conf and metadata, so it has an answer
  // before any data has been processed — the same reason Architecture sits
  // above the gate rather than inside the switch.
  if (tab === 'effective') return <EffectiveConfigTab inputs={pipelineInputs} />;

  if (failure !== null) {
    return <FailureState message={failure} />;
  }

  if (!hasData) {
    return <EmptyState />;
  }

  switch (tab) {
    case 'preview': return <PreviewSubTab pipelineInputs={previewInputs} />;
    case 'cim': return <CimModelsTab />;
    case 'fields': return <FieldsTab />;
    case 'transforms': return <TransformsTab />;
    default: return null;
  }
});
