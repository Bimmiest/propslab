import { useRef, useState, type KeyboardEvent } from 'react';
import { RawPanel } from '../raw/RawPanel';
import { PropsConfEditor } from '../editor/PropsConfEditor';
import { TransformsConfEditor } from '../editor/TransformsConfEditor';
import { PreviewPanel } from '../preview/PreviewPanel';
import { DictionaryView } from './lazyViews';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { useAppStore } from '../../store/useAppStore';

type MobileView = 'raw' | 'props' | 'transforms' | 'output' | 'dictionary';

const VIEWS: { id: MobileView; label: string; icon: IconName }[] = [
  { id: 'raw', label: 'Raw', icon: 'document' },
  { id: 'props', label: 'props', icon: 'settings' },
  { id: 'transforms', label: 'transforms', icon: 'refresh' },
  { id: 'output', label: 'Output', icon: 'eye' },
  { id: 'dictionary', label: 'Docs', icon: 'book' },
];

/**
 * Single-panel-at-a-time layout for narrow viewports. The desktop resizable
 * split collapses every column to an unusable width on a phone, so on mobile we
 * show one full-width panel and switch between them with a segmented control.
 *
 * The desktop activity rail has no equivalent here — it is icon-only, and touch
 * has no hover to reveal the labels — so the dictionary joins the strip as a
 * fifth labelled tab instead.
 */
export function MobileShell() {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const [simulatorView, setSimulatorView] = useState<Exclude<MobileView, 'dictionary'>>('raw');
  const tablistRef = useRef<HTMLDivElement>(null);

  // The dictionary tab is backed by the shared `activeView` so that deep links
  // (openDictionaryAt, from the editor hover or the command palette) land here
  // too; the other four are a local concern with no desktop counterpart.
  const view: MobileView = activeView === 'dictionary' ? 'dictionary' : simulatorView;

  const setView = (next: MobileView) => {
    if (next === 'dictionary') {
      setActiveView('dictionary');
      return;
    }
    setActiveView('simulator');
    setSimulatorView(next);
  };

  // Roving-tabindex keyboard navigation, matching the shared Tabs component:
  // only the active tab is in the tab order; arrows/Home/End move between tabs.
  const handleKeyDown = (e: KeyboardEvent) => {
    const current = VIEWS.findIndex((v) => v.id === view);
    let next = -1;
    if (e.key === 'ArrowRight') next = (current + 1) % VIEWS.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + VIEWS.length) % VIEWS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = VIEWS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = VIEWS[next];
    if (!target) return;
    setView(target.id);
    tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="h-full flex flex-col">
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Workspace panels"
        onKeyDown={handleKeyDown}
        className="shrink-0 flex items-stretch border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-x-auto"
      >
        {VIEWS.map((v) => {
          const isActive = v.id === view;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              id={`mobile-tab-${v.id}`}
              aria-selected={isActive}
              aria-controls={`mobile-tabpanel-${v.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setView(v.id)}
              className={[
                'flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 px-2 py-1.5',
                'text-[11px] font-medium cursor-pointer border-b-2 -mb-px outline-none focus-visible:ring-2 transition-colors',
                isActive
                  ? 'text-[var(--color-accent)] border-b-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] border-b-transparent hover:text-[var(--color-text-secondary)]',
              ].join(' ')}
            >
              <Icon name={v.icon} className="w-4 h-4 shrink-0" />
              <span className="truncate max-w-full">{v.label}</span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`mobile-tabpanel-${view}`}
        aria-labelledby={`mobile-tab-${view}`}
        className="flex-1 min-h-0"
      >
        {view === 'raw' && (
          <ErrorBoundary panelName="Raw Data">
            <RawPanel />
          </ErrorBoundary>
        )}
        {view === 'props' && (
          <ErrorBoundary panelName="props.conf Editor">
            <PropsConfEditor />
          </ErrorBoundary>
        )}
        {view === 'transforms' && (
          <ErrorBoundary panelName="transforms.conf Editor">
            <TransformsConfEditor />
          </ErrorBoundary>
        )}
        {view === 'output' && (
          <ErrorBoundary panelName="Output">
            <PreviewPanel />
          </ErrorBoundary>
        )}
        {view === 'dictionary' && (
          <ErrorBoundary panelName="Dictionary">
            <DictionaryView />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
