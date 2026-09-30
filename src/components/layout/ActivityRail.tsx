import { useRef, type KeyboardEvent } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { ActiveView } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';

interface RailItem {
  id: ActiveView;
  label: string;
  icon: IconName;
}

const ITEMS: RailItem[] = [
  { id: 'simulator', label: 'Simulator', icon: 'sliders' },
  { id: 'dictionary', label: 'Dictionary', icon: 'book' },
];

/**
 * Icon-only vertical switcher for the top-level workspace views.
 *
 * The buttons carry no visible text, so `aria-label` is load-bearing rather
 * than decorative: the Radix tooltip contributes `aria-describedby`, which
 * supplements an accessible name but cannot supply one. Without the label a
 * screen reader announces an unnamed button.
 *
 * Desktop only — see MobileShell, which folds these views into its labelled
 * segmented control. Hover is unavailable on touch, so an icon-only rail would
 * strand the labels there.
 */
export function ActivityRail({ dictionaryMounted = false }: { dictionaryMounted?: boolean }) {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const railRef = useRef<HTMLDivElement>(null);

  // Roving tabindex, matching MobileShell and the shared Tabs component: only
  // the active item sits in the tab order, and arrows move between items. The
  // rail is vertical, so Up/Down drive it — Left/Right are also accepted
  // because the pattern is muscle-memory from the horizontal tab strips.
  const handleKeyDown = (e: KeyboardEvent) => {
    const current = ITEMS.findIndex((i) => i.id === activeView);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (current + 1) % ITEMS.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (current - 1 + ITEMS.length) % ITEMS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ITEMS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = ITEMS[next];
    if (!target) return;
    setActiveView(target.id);
    railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    // Wrapped in a <nav> so the rail sits inside a landmark (axe `region`).
    <nav aria-label="Views" className="shrink-0 flex">
      <div
        ref={railRef}
        role="tablist"
        aria-label="Workspace views"
        aria-orientation="vertical"
        onKeyDown={handleKeyDown}
        className="shrink-0 w-12 flex flex-col items-center gap-1 py-2"
        style={{
          backgroundColor: 'var(--color-bg-secondary)',
          borderRight: '1px solid var(--color-border)',
        }}
      >
        {ITEMS.map((item) => {
          const isActive = item.id === activeView;
          // The dictionary panel is not in the DOM until it is first opened
          // (AppShell), and aria-controls must name an element that exists.
          const panelMounted = item.id !== 'dictionary' || dictionaryMounted;
          return (
            <Tooltip key={item.id} content={item.label} side="right">
              <button
                type="button"
                role="tab"
                id={`view-tab-${item.id}`}
                aria-label={item.label}
                aria-selected={isActive}
                aria-controls={panelMounted ? `view-panel-${item.id}` : undefined}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActiveView(item.id)}
                className={[
                  'flex items-center justify-center w-9 h-9 rounded-md border-none cursor-pointer',
                  'outline-none focus-visible:ring-2 transition-colors',
                  isActive
                    ? 'bg-[var(--color-accent)] text-[var(--color-text-on-accent)]'
                    : 'bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]',
                ].join(' ')}
              >
                <Icon name={item.icon} className="w-[18px] h-[18px]" />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </nav>
  );
}
