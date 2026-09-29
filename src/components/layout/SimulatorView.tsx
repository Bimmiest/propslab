import { memo } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import { RawPanel } from '../raw/RawPanel';
import { PropsConfEditor } from '../editor/PropsConfEditor';
import { TransformsConfEditor } from '../editor/TransformsConfEditor';
import { PreviewPanel } from '../preview/PreviewPanel';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { useAppStore } from '../../store/useAppStore';

function ResizeHandle({ direction = 'vertical' }: { direction?: 'horizontal' | 'vertical' }) {
  return (
    <Separator
      className={`
        group relative flex items-center justify-center
        ${direction === 'vertical' ? 'h-1.5 cursor-row-resize' : 'w-1.5 cursor-col-resize'}
        bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors
      `}
    >
      <div
        className={`
          rounded-full bg-[var(--color-text-muted)] group-hover:bg-white transition-colors
          ${direction === 'vertical' ? 'h-0.5 w-8' : 'w-0.5 h-8'}
        `}
      />
    </Separator>
  );
}

/**
 * The simulator workspace: inputs on the left, pipeline output on the right.
 *
 * Split out of AppShell when the activity rail arrived, so the shell only has
 * to choose between whole views. This subtree stays mounted while the
 * dictionary is on screen — see AppShell for why. Memoised: it takes no
 * props, so nothing the shell re-renders for need reach the editors.
 */
export const SimulatorView = memo(function SimulatorView() {
  const propsCollapsed = useAppStore((s) => !!s.collapsedPanels['props.conf']);
  const transformsCollapsed = useAppStore((s) => !!s.collapsedPanels['transforms.conf']);

  // Build the resizable panel group key based on which panels are expanded
  // This forces a clean re-mount when collapse state changes; the editors keep
  // their models and view state across it (modelRegistry).
  const layoutKey = `${propsCollapsed ? 'pc' : 'pe'}-${transformsCollapsed ? 'tc' : 'te'}`;

  return (
    // Sizes are STRINGS: react-resizable-panels v4 reads a number as pixels and
    // a string as a percentage. These were numbers, which happened to look right
    // because the library turns them into flex-grow ratios — but it also meant
    // every minSize was a handful of pixels, so a drag could crush any panel to
    // nothing.
    //
    // resizePreviewMode="separator": a pointer drag moves only a copy of the
    // separator and applies the split on release, so Monaco's automaticLayout
    // and the output tabs' long event lists re-lay out once instead of on every
    // pointer move. Keyboard resizing is unaffected (it still applies per key).
    //
    // No collapsedThreshold: none of these panels is `collapsible`. The editors
    // collapse only from their header buttons (store `collapsedPanels`), and a
    // drag stops at minSize, so there is no drag-to-collapse to tune.
    <Group orientation="horizontal" id="main-horizontal" resizePreviewMode="separator">
      {/* Left side: Raw, Props, Transforms */}
      <Panel defaultSize="38" minSize="20" id="left-inputs">
        <div className="h-full flex flex-col">
          {/* Resizable area for expanded panels */}
          <div className="flex-1 min-h-0">
            <Group orientation="vertical" id={`left-vertical-${layoutKey}`} key={layoutKey} resizePreviewMode="separator">
              <Panel defaultSize={propsCollapsed && transformsCollapsed ? '100' : propsCollapsed || transformsCollapsed ? '50' : '30'} minSize="10" id="raw-panel">
                <ErrorBoundary panelName="Raw Data">
                  <RawPanel />
                </ErrorBoundary>
              </Panel>
              {!propsCollapsed && (
                <>
                  <ResizeHandle direction="vertical" />
                  <Panel defaultSize="38" minSize="10" id="props-editor">
                    <ErrorBoundary panelName="props.conf Editor">
                      <PropsConfEditor />
                    </ErrorBoundary>
                  </Panel>
                </>
              )}
              {!transformsCollapsed && (
                <>
                  <ResizeHandle direction="vertical" />
                  <Panel defaultSize="32" minSize="10" id="transforms-editor">
                    <ErrorBoundary panelName="transforms.conf Editor">
                      <TransformsConfEditor />
                    </ErrorBoundary>
                  </Panel>
                </>
              )}
            </Group>
          </div>
          {/* Collapsed panels render as fixed-height bars at the bottom */}
          {propsCollapsed && (
            <ErrorBoundary panelName="props.conf Editor">
              <PropsConfEditor />
            </ErrorBoundary>
          )}
          {transformsCollapsed && (
            <ErrorBoundary panelName="transforms.conf Editor">
              <TransformsConfEditor />
            </ErrorBoundary>
          )}
        </div>
      </Panel>

      <ResizeHandle direction="horizontal" />

      {/* Right side: Output (Preview + CIM + Fields + Transforms + Validation + Architecture) */}
      <Panel defaultSize="62" minSize="30" id="output-panel">
        <ErrorBoundary panelName="Output">
          <PreviewPanel />
        </ErrorBoundary>
      </Panel>
    </Group>
  );
});
