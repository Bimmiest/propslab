import { useState } from 'react';
import { Header } from './Header';
import { StatusBar } from './StatusBar';
import { ActivityRail } from './ActivityRail';
import { SimulatorView } from './SimulatorView';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { HelpPanel } from '../help/HelpPanel';
import { SettingsPanel } from '../settings/SettingsPanel';
import { FirstRunBanner } from '../onboarding/FirstRunBanner';
import { DictionaryView, ScaffoldModal } from './lazyViews';
import { useProcessingPipeline } from '../../hooks/useProcessingPipeline';
import { useAppStore } from '../../store/useAppStore';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { CommandPalette } from '../ui/CommandPalette';
import { MobileShell } from './MobileShell';

export function AppShell() {
  useProcessingPipeline();

  const scaffoldOpen = useAppStore((s) => s.scaffoldOpen);
  const toggleScaffold = useAppStore((s) => s.toggleScaffold);
  const activeView = useAppStore((s) => s.activeView);
  const isMobile = useMediaQuery('(max-width: 767px)');

  // The dictionary is inert reference material, so don't pay for it until the
  // user asks. Once mounted it stays mounted, for the same reason the simulator
  // does.
  //
  // Latched during render rather than from an effect: an effect would mount the
  // dictionary one paint after the switch, so the first visit would flash an
  // empty pane. This is React's "adjust state during render" pattern — the
  // extra render happens before the browser sees anything.
  const [dictionaryMounted, setDictionaryMounted] = useState(false);
  if (activeView === 'dictionary' && !dictionaryMounted) setDictionaryMounted(true);

  return (
    <div className="h-full flex flex-col">
      {/* Chrome and overlays get boundaries of their own, so one of them
          failing (the scaffold chunk gone after a redeploy, say) costs a
          one-line alert rather than the editors and everything typed in them. */}
      <ErrorBoundary panelName="Header" variant="inline">
        <Header />
      </ErrorBoundary>
      <FirstRunBanner />
      <ErrorBoundary panelName="Help" variant="inline">
        <HelpPanel />
      </ErrorBoundary>
      <ErrorBoundary panelName="Settings" variant="inline">
        <SettingsPanel />
      </ErrorBoundary>
      <ErrorBoundary panelName="Command palette" variant="inline">
        <CommandPalette />
      </ErrorBoundary>
      {scaffoldOpen && (
        <ErrorBoundary panelName="Scaffold" variant="inline" onDismiss={toggleScaffold}>
          <ScaffoldModal />
        </ErrorBoundary>
      )}
      <div className="flex-1 min-h-0 flex">
        {!isMobile && <ActivityRail />}
        <main id="main-content" className="flex-1 min-w-0">
          {isMobile ? (
            <MobileShell />
          ) : (
            <>
              {/*
                Both views stay mounted and switch with `hidden`, rather than
                rendering conditionally. Unmounting the simulator would throw
                away Monaco's undo history, cursor and folding state along with
                every preview filter held in PreviewPanel's local state, and
                would pay full Monaco re-init on the way back. Monaco
                (automaticLayout) and react-resizable-panels both observe their
                container, so they re-measure correctly when shown again.

                Keep display-setting classes off these two wrappers: any
                `display` declaration outranks the UA stylesheet's `[hidden]`
                rule and the hidden view would render on top of the visible one.
              */}
              <div
                role="tabpanel"
                id="view-panel-simulator"
                aria-labelledby="view-tab-simulator"
                hidden={activeView !== 'simulator'}
                className="h-full"
              >
                <SimulatorView />
              </div>
              {dictionaryMounted && (
                <div
                  role="tabpanel"
                  id="view-panel-dictionary"
                  aria-labelledby="view-tab-dictionary"
                  hidden={activeView !== 'dictionary'}
                  className="h-full"
                >
                  <ErrorBoundary panelName="Dictionary">
                    <DictionaryView />
                  </ErrorBoundary>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
