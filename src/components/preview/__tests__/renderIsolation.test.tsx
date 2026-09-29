// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// renderIsolation.test.tsx
// Typing into an editor used to re-render the whole output, and hovering a
// field re-rendered every event card (#424). These count renders of a child
// to hold both down.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { PreviewPanel, type EnrichedEvent } from '../PreviewPanel';
import { HighlightedTab } from '../tabs/HighlightedTab';
import { useAppStore } from '../../../store/useAppStore';
import type { SplunkEvent } from '../../../engine/types';
import { toViewResult } from '../../../utils/viewResult';

const renders = vi.hoisted(() => ({ cim: 0, card: 0 }));

vi.mock('../tabs/CimModelsTab', () => ({
  CimModelsTab: () => {
    renders.cim++;
    return <p>cim tab</p>;
  },
}));

vi.mock('../tabs/shared/FieldEventCard', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tabs/shared/FieldEventCard')>();
  return {
    FieldEventCard: (props: ComponentProps<typeof real.FieldEventCard>) => {
      renders.card++;
      return createElement(real.FieldEventCard, props);
    },
  };
});

const initial = useAppStore.getState();

function makeEvent(raw: string, fields: Record<string, string>): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [
      { processor: 'EXTRACT-kv', phase: 'search-time', description: '', fieldsAdded: Object.keys(fields) },
    ],
  };
}

beforeEach(() => {
  useAppStore.setState(initial, true);
  renders.cim = 0;
  renders.card = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PreviewPanel render isolation', () => {
  it('does not re-render the active tab while the inputs are typed into or a run is in flight', () => {
    const result = toViewResult({
      events: [makeEvent('a=1', { a: '1' })],
      originalRaw: 'a=1',
      eventCount: 1,
      processingSteps: [],
      inputMetadata: initial.metadata,
    });
    useAppStore.setState({ activeOutputTab: 'cim', processingResult: result });
    render(<PreviewPanel />);
    expect(screen.getByText('cim tab')).toBeInTheDocument();
    const before = renders.cim;

    const { setPropsConf, setTransformsConf, setRawData, setIsProcessing } = useAppStore.getState();
    act(() => {
      for (const ch of '[st]\nEXTRACT-a = (?<a>\\d)') setPropsConf(useAppStore.getState().propsConf + ch);
    });
    act(() => setTransformsConf('[t]'));
    act(() => setRawData('a=2'));
    act(() => setIsProcessing(true));
    act(() => setIsProcessing(false));

    expect(renders.cim).toBe(before);
  });
});

describe('HighlightedTab hover', () => {
  it('restyles the spans without re-rendering any card', () => {
    const items: EnrichedEvent[] = [
      makeEvent('user=alice action=login', { user: 'alice', action: 'login' }),
      makeEvent('user=bob action=logout', { user: 'bob', action: 'logout' }),
    ].map((event) => ({ event, originalRaw: event._raw, hasChanges: false, hasMetadataChanges: false, isDropped: false }));

    render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    const before = renders.card;
    expect(before).toBeGreaterThan(0);

    const alice = screen.getByText('alice');
    const login = screen.getByText('login');
    fireEvent.mouseEnter(alice);
    expect(login).toHaveStyle({ opacity: '0.2' });
    expect(alice).toHaveStyle({ opacity: '1' });
    fireEvent.mouseLeave(alice);
    expect(login).toHaveStyle({ opacity: '1' });

    expect(renders.card).toBe(before);

    // A pin changes which rows show, so that does re-render.
    fireEvent.click(alice);
    expect(screen.getByText('bob')).toHaveStyle({ opacity: '1' });
    expect(screen.getByText('logout')).toHaveStyle({ opacity: '0.2' });
  });
});
