import type React from 'react';
import { useCallback, useRef } from 'react';
import { tabId, tabPanelId } from './tabIds';

interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
  badgeVariant?: 'error' | 'warning' | 'info' | 'default';
}

interface TabsProps {
  /**
   * From the caller's useId(). The caller renders the tabpanel, so it builds
   * the panel's ids from the same prefix with `tabIds.ts`.
   */
  idPrefix: string;
  tabs: TabItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  ariaLabel?: string;
  size?: 'sm' | 'md';
  variant?: 'underline' | 'secondary';
}

export function Tabs({ idPrefix, tabs, activeTab, onTabChange, ariaLabel, size = 'md', variant = 'underline' }: TabsProps) {
  const tablistRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIndex = tabs.findIndex((t) => t.id === activeTab);
      let nextIndex = -1;

      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (e.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (e.key === 'Home') {
        nextIndex = 0;
      } else if (e.key === 'End') {
        nextIndex = tabs.length - 1;
      }

      const nextTab = tabs[nextIndex];
      if (nextIndex >= 0 && nextTab) {
        e.preventDefault();
        onTabChange(nextTab.id);
        const buttons = tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        buttons?.[nextIndex]?.focus();
      }
    },
    [tabs, activeTab, onTabChange]
  );

  return (
    <div
      ref={tablistRef}
      role="tablist"
      aria-label={ariaLabel}
      className={variant === 'secondary' ? 'flex gap-0.5 p-1 overflow-x-auto min-w-0' : 'flex gap-1 overflow-x-auto min-w-0'}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const underlineClasses = [
          'relative flex items-center gap-1.5 font-medium cursor-pointer outline-none focus-visible:ring-2 border-b-2 -mb-px shrink-0 whitespace-nowrap',
          size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-1.5 text-sm',
          isActive
            ? 'text-[var(--color-accent)] border-b-[var(--color-accent)]'
            : 'text-[var(--color-text-muted)] border-b-transparent hover:text-[var(--color-text-secondary)]',
        ].join(' ');
        const secondaryClasses = [
          'relative flex items-center gap-1.5 font-medium cursor-pointer outline-none focus-visible:ring-1 rounded transition-colors shrink-0 whitespace-nowrap',
          size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
          isActive
            ? 'bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] border border-[var(--color-border)] shadow-sm'
            : 'text-[var(--color-text-muted)] border border-transparent hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]',
        ].join(' ');
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={tabPanelId(idPrefix, tab.id)}
            id={tabId(idPrefix, tab.id)}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            className={variant === 'secondary' ? secondaryClasses : underlineClasses}
          >
            {tab.icon && <span className="flex-shrink-0">{tab.icon}</span>}
            <span>{tab.label}</span>
            {tab.badge !== undefined && tab.badge !== 0 && (
              <span
                className="ml-1 text-[10px] font-semibold rounded-full px-1.5 py-0 leading-4"
                style={{
                  backgroundColor: tab.badgeVariant === 'error' ? 'var(--color-error)' : tab.badgeVariant === 'warning' ? 'var(--color-warning)' : 'var(--color-accent)',
                  color: 'var(--color-text-on-accent)',
                }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
