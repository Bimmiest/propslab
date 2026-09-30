// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { HighlightedTab } from '../HighlightedTab';
import { useAppStore } from '../../../../store/useAppStore';
import type { EnrichedEvent } from '../../PreviewPanel';
import type { SplunkEvent, ProcessingStep } from '../../../../engine/types';

function makeEvent(
  raw: string,
  fields: Record<string, string | string[]>,
  traces: ProcessingStep[],
): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: traces,
  };
}

function toItem(event: SplunkEvent): EnrichedEvent {
  return {
    event,
    originalRaw: event._raw,
    hasChanges: false,
    hasMetadataChanges: false,
    isDropped: false,
  };
}

const eventWithAuto = makeEvent(
  '{"user":"alice","status":"ok"}',
  { user: 'alice', status: 'ok' },
  [{ processor: 'KV_MODE', phase: 'search-time', description: '', fieldsAdded: ['user', 'status'] }],
);

const eventWithManual = makeEvent(
  'admin logged in',
  { username: 'admin' },
  [{ processor: 'EXTRACT-user', phase: 'search-time', description: '', fieldsAdded: ['username'] }],
);

const eventWithBoth = makeEvent(
  'login: bob',
  { user: 'bob', action: 'login' },
  [
    { processor: 'KV_MODE', phase: 'search-time', description: '', fieldsAdded: ['user'] },
    { processor: 'EXTRACT-action', phase: 'search-time', description: '', fieldsAdded: ['action'] },
  ],
);

const items: EnrichedEvent[] = [toItem(eventWithAuto), toItem(eventWithManual), toItem(eventWithBoth)];

const initial = useAppStore.getState();

describe('HighlightedTab', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
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
    const { container } = render(
      <HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />,
    );
    // Click the "username" field chip in the sidebar to pin it.
    const sidebarUsername = within(container).getAllByText('username')[0]!;
    fireEvent.click(sidebarUsername);
    // Only events containing `username` (eventWithManual) should remain — pin counter appears.
    expect(screen.getByText(/events match 1 pinned field/i)).toBeInTheDocument();
  });

  // Fills go through tint(): a field colour can fall back to a var(), and an
  // appended alpha byte on a var() is dropped by the browser (#432).
  it('tints a pinned field row with color-mix, not an appended alpha byte', () => {
    const { container } = render(
      <HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />,
    );
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
  // A pin filters the whole dataset, so the render is capped: a field on every
  // event would otherwise lock the UI.
  it('caps the rendered rows when a pin matches more than the window', () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      toItem(makeEvent(`line ${i}`, { username: `u${i}` }, [
        { processor: 'EXTRACT-user', phase: 'search-time', description: '', fieldsAdded: ['username'] },
      ])),
    );
    const { container } = render(
      <HighlightedTab items={many.slice(0, 10)} allEvents={many} currentPage={1} eventsPerPage={10} />,
    );
    fireEvent.click(within(container).getAllByText('username')[0]!);

    expect(screen.getAllByText(/Event #/)).toHaveLength(100);
    expect(screen.getByText(/Showing the first 100 of 150 events/i)).toBeInTheDocument();
    // The summary counts every match, not just the rendered window (#432).
    expect(screen.getByText(/150\/150 events match 1 pinned field/)).toBeInTheDocument();
  });

  it('does not cap or announce a truncation when the pin matches few events', () => {
    const { container } = render(
      <HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />,
    );
    fireEvent.click(within(container).getAllByText('username')[0]!);
    expect(screen.queryByText(/Showing the first/i)).not.toBeInTheDocument();
  });
});

describe('HighlightedTab filter pills (#495)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('report the chosen filter with aria-pressed, not by colour alone', () => {
    render(<HighlightedTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    const pill = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) });
    const pressed = ['Auto', 'Manual', 'Calculated', 'All'].filter((l) => pill(l).getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);

    fireEvent.click(pill('Manual'));
    expect(pill('Manual')).toHaveAttribute('aria-pressed', 'true');
    expect(pill(pressed[0]!)).toHaveAttribute('aria-pressed', 'false');
  });
});
