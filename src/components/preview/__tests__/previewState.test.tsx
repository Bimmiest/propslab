// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// previewState.test.tsx
// What the Preview tab keeps (#497): its sub-tab and filters outlive the tab
// unmounting, pins follow the fields the run produced, and the page-size
// choice stays available while there is one to make.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { PreviewPanel } from '../PreviewPanel';
import type { EnrichedEvent } from '../enrichEvents';
import { HighlightedTab } from '../tabs/HighlightedTab';
import { useAppStore } from '../../../store/useAppStore';
import { toViewResult, type ViewResult } from '../../../utils/viewResult';
import { makeEvent } from '../../../test/makeEvent';
import type { EventMetadata } from '../../../engine/types';

const initial = useAppStore.getState();
const meta: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function resultOf(fields: Record<string, string>[]): ViewResult {
  return toViewResult({
    events: fields.map((f, i) =>
      makeEvent(
        Object.entries(f)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ') || `event ${i}`,
        {
          fields: f,
          lineNumbers: { start: i + 1, end: i + 1 },
          processingTrace: [
            { processor: 'EXTRACT-kv', phase: 'search-time', description: '', fieldsAdded: Object.keys(f) },
          ],
        },
      ),
    ),
    originalRaw: '',
    eventCount: fields.length,
    processingSteps: [],
    inputMetadata: meta,
  });
}

beforeEach(() => {
  useAppStore.setState({ ...initial, metadata: meta, activeOutputTab: 'preview' }, true);
});

describe("the Preview tab's sub-tab and filters", () => {
  it('survive an output-tab switch and a remount', () => {
    useAppStore.setState({ processingResult: resultOf([{ user: 'alice' }, { user: 'bob' }]) });
    const { unmount } = render(<PreviewPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Extractions' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), { target: { value: 'alice' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Fields' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByRole('tab', { name: 'Extractions' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Search events' })).toHaveValue('alice');

    // The phone layout, and the breakpoint between the two layouts, remount it.
    unmount();
    render(<PreviewPanel />);
    expect(screen.getByRole('tab', { name: 'Extractions' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Search events' })).toHaveValue('alice');
    // Filtered at once, not after a debounce: the settled search starts from the store.
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
  });

  it('go back to the first page when changed', () => {
    useAppStore.setState({
      processingResult: resultOf(Array.from({ length: 12 }, (_, i) => ({ n: String(i) }))),
      eventsPerPage: 5,
    });
    render(<PreviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(useAppStore.getState().currentPage).toBe(2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search events' }), { target: { value: 'n=1' } });
    expect(useAppStore.getState().currentPage).toBe(1);
  });
});

describe('the page-size selector', () => {
  it('stays while there are more events than the smallest page', () => {
    useAppStore.setState({
      processingResult: resultOf(Array.from({ length: 8 }, (_, i) => ({ n: String(i) }))),
      eventsPerPage: 5,
    });
    render(<PreviewPanel />);
    const perPage = () => screen.queryByRole('combobox', { name: 'Per page:' });
    fireEvent.change(perPage()!, { target: { value: '25' } });
    expect(useAppStore.getState().eventsPerPage).toBe(25);
    // One page of 8 now, but 5 is still a choice, so the control stays.
    expect(perPage()).toHaveValue('25');
    fireEvent.change(perPage()!, { target: { value: '5' } });
    expect(useAppStore.getState().eventsPerPage).toBe(5);
  });

  it('is not shown when no page size would change anything', () => {
    useAppStore.setState({ processingResult: resultOf([{ n: '1' }, { n: '2' }]) });
    render(<PreviewPanel />);
    expect(screen.queryByRole('combobox', { name: 'Per page:' })).not.toBeInTheDocument();
  });
});

describe('Extractions pins', () => {
  const itemsOf = (result: ViewResult): EnrichedEvent[] =>
    result.events.map((event) => ({
      event,
      searchText: event._raw.toLowerCase(),
      originalRaw: event._raw,
      hasChanges: false,
      hasMetadataChanges: false,
      isDropped: false,
    }));

  it('are dropped when the run no longer produces the field', () => {
    const first = resultOf([{ status: '200', user: 'alice' }, { user: 'bob' }]);
    const tab = (result: ViewResult) => {
      const items = itemsOf(result);
      return (
        <HighlightedTab
          items={items}
          allEvents={items}
          currentPage={1}
          eventsPerPage={10}
          fieldStats={result.fieldStats}
        />
      );
    };
    const { container, rerender } = render(tab(first));
    fireEvent.click(within(container).getByTitle(/^status \(manual\)/));
    expect(container.textContent).toContain('1/2 events match 1 pinned field');

    // The EXTRACT changes so `status` is gone: no "0/2" with nothing to unpin.
    act(() => {
      rerender(tab(resultOf([{ user: 'alice' }, { user: 'bob' }])));
    });
    expect(container.textContent).not.toContain('pinned field');
    expect(within(container).getAllByTitle(/^user \(manual\)/)).toHaveLength(2);
  });

  it('are kept while the field is still produced, even if a search hides it', () => {
    const result = resultOf([{ status: '200', user: 'alice' }, { user: 'bob' }]);
    const all = itemsOf(result);
    const { container, rerender } = render(
      <HighlightedTab items={all} allEvents={all} currentPage={1} eventsPerPage={10} fieldStats={result.fieldStats} />,
    );
    fireEvent.click(within(container).getByTitle(/^status \(manual\)/));
    const bob = [all[1]!];
    rerender(
      <HighlightedTab items={bob} allEvents={bob} currentPage={1} eventsPerPage={10} fieldStats={result.fieldStats} />,
    );
    expect(container.textContent).toContain('0/1 events match 1 pinned field');
  });
});
