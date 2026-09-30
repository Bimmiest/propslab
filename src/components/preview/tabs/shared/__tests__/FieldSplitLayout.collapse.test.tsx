// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// Hiding the Extractions sidebar used to render the events in another tree,
// remounting every card and losing its scroll, and showing it again restored
// the split from mount time rather than the last one dragged to (#497).
//
// jsdom lays nothing out, so a drag cannot be made here; the group's
// `onLayoutChanged` is captured instead and called as a drag's end calls it.
// Everything else is the real panel library.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useEffect, type ComponentProps } from 'react';
import type { Layout } from 'react-resizable-panels';
import { FieldSplitLayout } from '../FieldSplitLayout';

const captured = vi.hoisted(() => ({ onLayoutChanged: null as ((layout: Layout) => void) | null }));

vi.mock('react-resizable-panels', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-resizable-panels')>();
  return {
    ...real,
    Group: (props: ComponentProps<typeof real.Group>) => {
      captured.onLayoutChanged = (layout) => props.onLayoutChanged?.(layout, { isUserInteraction: true });
      return <real.Group {...props} />;
    },
  };
});

const KEY = 'collapse-split-layout';
const EVENTS = `${KEY}-events`;
const SIDEBAR = `${KEY}-sidebar`;

function Body({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div>body</div>;
}

describe('FieldSplitLayout — hiding and showing the sidebar (#497)', () => {
  let mounts = 0;
  const onMount = () => { mounts++; };
  const layout = (collapsed: boolean) => (
    <FieldSplitLayout storageKey={KEY} collapsed={collapsed} sidebar={<div>side</div>}>
      <Body onMount={onMount} />
    </FieldSplitLayout>
  );
  const flexGrow = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[id="${id}"]`)?.style.flexGrow;

  beforeEach(() => {
    localStorage.clear();
    mounts = 0;
  });

  it('keeps the events mounted', () => {
    const { rerender } = render(layout(false));
    rerender(layout(true));
    expect(screen.queryByText('side')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Events' })).toHaveTextContent('body');
    rerender(layout(false));
    expect(screen.getByText('side')).toBeInTheDocument();
    expect(mounts).toBe(1);
  });

  it('brings the sidebar back at the last size it was dragged to', () => {
    localStorage.setItem(KEY, JSON.stringify({ [EVENTS]: 70, [SIDEBAR]: 30 }));
    const { container, rerender } = render(layout(false));
    expect(flexGrow(container, SIDEBAR)).toBe('30');

    act(() => captured.onLayoutChanged!({ [EVENTS]: 60, [SIDEBAR]: 40 }));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ [EVENTS]: 60, [SIDEBAR]: 40 });

    rerender(layout(true));
    // The events pane alone is not a split to remember.
    act(() => captured.onLayoutChanged!({ [EVENTS]: 100 }));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ [EVENTS]: 60, [SIDEBAR]: 40 });

    rerender(layout(false));
    expect(flexGrow(container, SIDEBAR)).toBe('40');
    expect(flexGrow(container, EVENTS)).toBe('60');
  });
});
