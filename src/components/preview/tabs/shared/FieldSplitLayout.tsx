import { useState, type ReactNode } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { Layout } from 'react-resizable-panels';

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
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (isLayout(parsed, storageKey)) return parsed;
    }
  } catch { /* ignore */ }
  return undefined;
}

interface FieldSplitLayoutProps {
  storageKey: string;
  collapsed: boolean;
  sidebar: ReactNode;
  children: ReactNode;
}

export function FieldSplitLayout({ storageKey, collapsed, sidebar, children }: FieldSplitLayoutProps) {
  const [initialLayout] = useState(() => getSavedLayout(storageKey));

  const saveLayout = (layout: Layout) => {
    try { localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* ignore */ }
  };

  if (collapsed) {
    return (
      <div className="flex-1 min-w-0 h-full overflow-auto p-3 space-y-3">
        {children}
      </div>
    );
  }

  // Preview the drag and apply on release: the events pane can hold thousands
  // of rows, which otherwise re-wrap on every pointer move.
  return (
    <Group orientation="horizontal" id={storageKey} defaultLayout={initialLayout} onLayoutChanged={saveLayout} resizePreviewMode="separator">
      <Panel defaultSize="85" minSize="40" id={eventsId(storageKey)}>
        <div className="h-full overflow-auto p-3 space-y-3">
          {children}
        </div>
      </Panel>
      <Separator className="w-1.5 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors group relative flex items-center justify-center">
        <div className="w-0.5 h-8 rounded-full bg-[var(--color-text-muted)] group-hover:bg-white transition-colors" />
      </Separator>
      <Panel defaultSize="15" minSize="10" id={sidebarId(storageKey)}>
        {sidebar}
      </Panel>
    </Group>
  );
}
