import { useState, type ReactNode } from 'react';
import { Panel, Group } from 'react-resizable-panels';
import type { Layout } from 'react-resizable-panels';
import { ResizeHandle } from '../../../ui/ResizeHandle';
import { safeStorage } from '../../../../utils/safeStorage';
import { MOBILE_QUERY, useMediaQuery } from '../../../../hooks/useMediaQuery';

const eventsId = (storageKey: string) => `${storageKey}-events`;
const sidebarId = (storageKey: string) => `${storageKey}-sidebar`;

/**
 * Validate the shape rather than trusting the parse. `JSON.parse` succeeds for
 * plenty of values that are not a Layout — `"null"`, an array, `{events:"x"}` —
 * and each would be handed straight to the panel group. This mirrors the guard
 * `loadSettings` already applies to persisted settings.
 *
 * The library keys a Layout by panel id, which is also what `onLayoutChanged`
 * saves, so the check is against those ids. A value keyed any other way —
 * `{events, sidebar}` was once checked for, though nothing ever wrote it — is
 * ignored and the panels' own default sizes apply.
 */
function isLayout(value: unknown, storageKey: string): value is Layout {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const events = o[eventsId(storageKey)];
  const sidebar = o[sidebarId(storageKey)];
  return (
    Object.keys(o).length === 2 &&
    typeof events === 'number' &&
    Number.isFinite(events) &&
    typeof sidebar === 'number' &&
    Number.isFinite(sidebar)
  );
}

function getSavedLayout(storageKey: string): Layout | undefined {
  const saved = safeStorage.get(storageKey);
  if (!saved) return undefined;
  try {
    const parsed: unknown = JSON.parse(saved);
    if (isLayout(parsed, storageKey)) return parsed;
  } catch {
    /* not JSON */
  }
  return undefined;
}

/**
 * The events pane scrolls, and a long event (one wide JSON object, say)
 * overflows it with nothing focusable inside to scroll to, so a keyboard user
 * could not reach the rest. A named tab stop lets the arrow keys scroll it.
 */
const SCROLL_REGION = { tabIndex: 0, role: 'region', 'aria-label': 'Events' } as const;

interface FieldSplitLayoutProps {
  storageKey: string;
  collapsed: boolean;
  sidebar: ReactNode;
  children: ReactNode;
  /** Hides the sidebar: Escape in the phone's drawer calls it. */
  onCollapse?: () => void;
}

export function FieldSplitLayout(props: FieldSplitLayoutProps) {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  return isMobile ? <FieldDrawerLayout {...props} /> : <FieldPanelLayout {...props} />;
}

/**
 * On a phone the sidebar is a drawer over the events, not a column beside
 * them: a fifth of 390 px cut every field name to one letter (#893).
 */
function FieldDrawerLayout({ collapsed, sidebar, children, onCollapse }: FieldSplitLayoutProps) {
  return (
    <div className="relative flex-1 min-w-0 h-full">
      <div className="h-full overflow-auto p-3 space-y-3" {...SCROLL_REGION}>
        {children}
      </div>
      {!collapsed && (
        // The keys bubble up from the sidebar's own controls; the wrapper is not itself interactive.
        <div
          data-state="open"
          className="drawer-slide absolute inset-y-0 right-0 z-10 w-72 max-w-[85%] border-l border-[var(--color-border)] shadow-lg"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && onCollapse) {
              e.stopPropagation();
              onCollapse();
            }
          }}
        >
          {sidebar}
        </div>
      )}
    </div>
  );
}

function FieldPanelLayout({ storageKey, collapsed, sidebar, children }: FieldSplitLayoutProps) {
  // The split to show when the sidebar is (re-)shown: the saved one at mount,
  // then each one the user drags to. The group lays a re-added panel out from
  // its current `defaultLayout`, so this is what that prop carries, rather
  // than the mount-time value, which is what hiding and showing restored.
  const [layout, setLayout] = useState(() => getSavedLayout(storageKey));

  const saveLayout = (next: Layout) => {
    // With the sidebar hidden the group holds the events pane alone: not a split to keep.
    if (!isLayout(next, storageKey)) return;
    setLayout(next);
    safeStorage.set(storageKey, JSON.stringify(next));
  };

  // One tree whether or not the sidebar shows: the events pane stays the
  // group's first panel, so hiding the sidebar does not remount every event
  // card beneath it or lose its scroll position.
  return (
    <Group
      orientation="horizontal"
      id={storageKey}
      defaultLayout={layout}
      onLayoutChanged={saveLayout}
      resizePreviewMode="separator"
    >
      <Panel defaultSize="85" minSize="40" id={eventsId(storageKey)}>
        <div className="h-full overflow-auto p-3 space-y-3" {...SCROLL_REGION}>
          {children}
        </div>
      </Panel>
      {!collapsed && <ResizeHandle direction="horizontal" />}
      {!collapsed && (
        // A floor in rem, not a share: a share of a pane about 800 px wide
        // cut bytes_received, bytes_sent and bytes_total all to "byt…" (#893).
        <Panel defaultSize="15" minSize="9rem" id={sidebarId(storageKey)}>
          {sidebar}
        </Panel>
      )}
    </Group>
  );
}
