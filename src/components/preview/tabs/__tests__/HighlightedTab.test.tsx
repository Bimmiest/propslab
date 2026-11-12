// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { HighlightedTab } from '../HighlightedTab';
import { useAppStore } from '../../../../store/useAppStore';
import type { EnrichedEvent } from '../../enrichEvents';
import type { SplunkEvent, ProcessingStep } from '../../../../engine/types';
import { makeEvent } from '../../../../test/makeEvent';

function eventWithTrace(raw: string, fields: Record<string, string | string[]>, traces: ProcessingStep[]): SplunkEvent {
  return makeEvent(raw, { fields, processingTrace: traces });
}

function toItem(event: SplunkEvent): EnrichedEvent {
  return {
    event,
    searchText: event._raw.toLowerCase(),
    originalRaw: event._raw,
    hasChanges: false,
    hasMetadataChanges: false,
    isDropped: false,
  };
}

const eventWithAuto = eventWithTrace('{"user":"alice","status":"ok"}', { user: 'alice', status: 'ok' }, [
  { processor: 'KV_MODE', phase: 'search-time', description: '', fieldsAdded: ['user', 'status'] },
]);

const eventWithManual = eventWithTrace('admin logged in', { username: 'admin' }, [
  { processor: 'EXTRACT-user', phase: 'search-time', description: '', fieldsAdded: ['username'] },
]);

const eventWithBoth = eventWithTrace('login: bob', { user: 'bob', action: 'login' }, [
  { processor: 'KV_MODE', phase: 'search-time', description: '', fieldsAdded: ['user'] },
  { processor: 'EXTRACT-action', phase: 'search-time', description: '', fieldsAdded: ['action'] },
]);

const items: EnrichedEvent[] = [toItem(eventWithAuto), toItem(eventWithManual), toItem(eventWithBoth)];

const initial = useAppStore.getState();

describe('HighlightedTab', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('counts directives that did not fire over every page, not this page only (#772)', () => {
    const missed = makeEvent('page one', {
      noOps: [
        {
          directive: 'EXTRACT-action',
          file: 'props.conf',
          line: 2,
          phase: 'search-time',
          reason: { kind: 'no-match' },
        },
      ],
    });
    const page1 = [toItem(missed)];
    render(
      <HighlightedTab items={page1} allEvents={[...page1, toItem(eventWithBoth)]} currentPage={1} eventsPerPage={1} />,
    );
    expect(screen.queryByText(/Did not fire/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fired on some events (1)' })).toBeInTheDocument();
  });

  it('renders an event card per item by default', () => {
    render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    expect(screen.getAllByText(/Event #/)).toHaveLength(3);
  });

  it('shows Auto / Manual / Calculated / All filter pills', () => {
    render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    for (const label of ['Auto', 'Manual', 'Calculated', 'All']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it('filter pill counts reflect auto vs manual classification', () => {
    render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    // auto fields: user, status (user also appears as auto in eventWithBoth)
    expect(screen.getByRole('button', { name: /^Auto\s*\(2\)/ })).toBeInTheDocument();
    // manual fields: username, action
    expect(screen.getByRole('button', { name: /^Manual\s*\(2\)/ })).toBeInTheDocument();
  });

  it('toggles sidebar on Fields button click', () => {
    render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    const fieldsBtn = screen.getByRole('button', { name: /^Fields/ });
    // Sidebar starts open — at least one field name should be visible in the sidebar tree.
    // Search input in sidebar has placeholder "Filter fields..." — look for it.
    expect(screen.getByPlaceholderText(/Filter fields/i)).toBeInTheDocument();
    fireEvent.click(fieldsBtn);
    expect(screen.queryByPlaceholderText(/Filter fields/i)).not.toBeInTheDocument();
  });

  it('renders "events match pinned" counter when a field is pinned via Fields sidebar', () => {
    const { container } = render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    // Click the "username" field chip in the sidebar to pin it.
    const sidebarUsername = within(container).getAllByText('username')[0]!;
    fireEvent.click(sidebarUsername);
    // Only events containing `username` (eventWithManual) should remain — pin counter appears.
    expect(screen.getByText(/events match 1 pinned field/i)).toBeInTheDocument();
  });

  // Fills go through tint(): a field colour can fall back to a var(), and an
  // appended alpha byte on a var() is dropped by the browser (#432).
  it('tints a pinned field row with color-mix, not an appended alpha byte', () => {
    const { container } = render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    fireEvent.click(within(container).getAllByText('username')[0]!);
    const row = within(container).getAllByText('username')[0]!.closest<HTMLElement>('[aria-pressed="true"]')!;
    expect(row.getAttribute('style')).toMatch(/background-color: color-mix\(in srgb, rgb\([^)]+\) 13%, transparent\)/);
  });

  // UI-2: the "Event #" badge uses the event's true global position, not page-local index.
  it('numbers events by their global position across pages', () => {
    // Page 2 of 2-per-page: the single item is the 3rd event overall.
    render(<HighlightedTab items={[toItem(eventWithBoth)]} allEvents={items} currentPage={2} eventsPerPage={2} />);
    expect(screen.getAllByText(/Event #/)).toHaveLength(1);
    expect(screen.getByText(/Event #\s*3/)).toBeInTheDocument();
  });

  // UI-2: pinning is a global filter — it surfaces matches from other pages with their
  // true index, and the counter is out of the total event count (not the page size).
  it('pinning spans all events with correct global index and counter', () => {
    const { container } = render(
      <HighlightedTab items={[toItem(eventWithAuto)]} allEvents={items} currentPage={1} eventsPerPage={1} />,
    );
    // eventWithManual (global index 2) is not on the current page; pinning username surfaces it.
    fireEvent.click(within(container).getAllByText('username')[0]!);
    expect(screen.getByText(/1\/3 events match/)).toBeInTheDocument();
    expect(screen.getByText(/Event #\s*2/)).toBeInTheDocument();
  });
  // A pin filters every event, and the pager pages through its matches: the
  // page size bounds the cards rendered (#880).
  describe('with a pinned field', () => {
    // Every third event has `username`: the matches are events 1, 4, 7, …
    const many = Array.from({ length: 150 }, (_, i) =>
      toItem(
        i % 3 === 0
          ? eventWithTrace(`line ${i}`, { username: `u${i}` }, [
              { processor: 'EXTRACT-user', phase: 'search-time', description: '', fieldsAdded: ['username'] },
            ])
          : eventWithTrace(`line ${i}`, { other: `o${i}` }, [
              { processor: 'EXTRACT-other', phase: 'search-time', description: '', fieldsAdded: ['other'] },
            ]),
      ),
    );

    it('shows one page of the matches, numbered as in the dataset', () => {
      const onPinnedViewChange = vi.fn();
      const { container, rerender } = render(
        <HighlightedTab
          items={many.slice(0, 10)}
          allEvents={many}
          currentPage={1}
          eventsPerPage={10}
          onPinnedViewChange={onPinnedViewChange}
        />,
      );
      fireEvent.click(within(container).getAllByText('username')[0]!);

      expect(screen.getAllByText(/Event #/)).toHaveLength(10);
      expect(screen.getByText(/Event #\s*28\b/)).toBeInTheDocument();
      expect(screen.queryByText(/Event #\s*31\b/)).not.toBeInTheDocument();
      // The summary counts every match, not the page (#432).
      expect(screen.getByText(/50\/150 events match 1 pinned field/)).toBeInTheDocument();
      expect(onPinnedViewChange).toHaveBeenLastCalledWith({ total: 50, scope: 'with username' });

      // Page 2 of the matches: the 11th to the 20th match.
      rerender(
        <HighlightedTab
          items={many.slice(10, 20)}
          allEvents={many}
          currentPage={2}
          eventsPerPage={10}
          onPinnedViewChange={onPinnedViewChange}
        />,
      );
      expect(screen.getAllByText(/Event #/)).toHaveLength(10);
      expect(screen.getByText(/Event #\s*31\b/)).toBeInTheDocument();
      expect(screen.getByText(/Event #\s*58\b/)).toBeInTheDocument();
      expect(screen.queryByText(/Event #\s*28\b/)).not.toBeInTheDocument();
    });

    it('shows the last page of the matches for a page past them', () => {
      const { container } = render(
        <HighlightedTab items={many.slice(140)} allEvents={many} currentPage={15} eventsPerPage={10} />,
      );
      fireEvent.click(within(container).getAllByText('username')[0]!);
      expect(screen.getAllByText(/Event #/)).toHaveLength(10);
      expect(screen.getByText(/Event #\s*148\b/)).toBeInTheDocument();
    });

    it('starts the pager at the first page when the pins change', () => {
      useAppStore.setState({ currentPage: 4 });
      const { container } = render(
        <HighlightedTab items={many.slice(30, 40)} allEvents={many} currentPage={4} eventsPerPage={10} />,
      );
      expect(useAppStore.getState().currentPage).toBe(4);
      fireEvent.click(within(container).getAllByText('username')[0]!);
      expect(useAppStore.getState().currentPage).toBe(1);
    });

    it('tells the pager when no field is pinned any more, and when the tab goes', () => {
      const onPinnedViewChange = vi.fn();
      const { container, unmount } = render(
        <HighlightedTab
          items={many.slice(0, 10)}
          allEvents={many}
          currentPage={1}
          eventsPerPage={10}
          onPinnedViewChange={onPinnedViewChange}
        />,
      );
      expect(onPinnedViewChange).not.toHaveBeenCalled();
      const pin = () => fireEvent.click(within(container).getAllByText('username')[0]!);
      pin();
      expect(onPinnedViewChange).toHaveBeenLastCalledWith({ total: 50, scope: 'with username' });
      pin();
      expect(onPinnedViewChange).toHaveBeenLastCalledWith(null);
      // Back to the page of every event.
      expect(screen.getAllByText(/Event #/)).toHaveLength(10);

      pin();
      onPinnedViewChange.mockClear();
      unmount();
      expect(onPinnedViewChange).toHaveBeenCalledWith(null);
    });
  });
});

describe('HighlightedTab filter pills (#495)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('report the chosen filter with aria-pressed, not by colour alone', () => {
    render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    const pill = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) });
    const pressed = ['Auto', 'Manual', 'Calculated', 'All'].filter(
      (l) => pill(l).getAttribute('aria-pressed') === 'true',
    );
    expect(pressed).toHaveLength(1);

    fireEvent.click(pill('Manual'));
    expect(pill('Manual')).toHaveAttribute('aria-pressed', 'true');
    expect(pill(pressed[0]!)).toHaveAttribute('aria-pressed', 'false');
  });
});
