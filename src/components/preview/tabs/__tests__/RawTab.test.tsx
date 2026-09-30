// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useAppStore } from '../../../../store/useAppStore';
import { RawTab } from '../RawTab';
import type { EnrichedEvent } from '../../PreviewPanel';
import type { SplunkEvent } from '../../../../engine/types';
import { EMPTY_FIELD_STATS } from '../../../../utils/fieldStats';

function makeItem(raw: string, line: number): EnrichedEvent {
  const event: SplunkEvent = {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: line, end: line },
    processingTrace: [],
  };
  return { event, searchText: raw.toLowerCase(), originalRaw: raw, hasChanges: false, hasMetadataChanges: false, isDropped: false };
}

const pageOne = [makeItem('first event', 1)];
const pageTwo = [makeItem('second event', 2)];

// The expanded metadata bar renders `sourcetype=…`; the label and value live in
// separate elements, so match against the flattened text rather than a node.
const metadataShown = () => document.body.textContent.includes('sourcetype');

// EventRow holds expand/selection state locally, so rows are keyed by event,
// not by their slot on the page: one event's expanded state must not appear on
// another after a page change.
describe('RawTab — row state does not bleed across pages', () => {
  it('does not carry an expanded row onto the next page', () => {
    const { rerender } = render(
      <RawTab items={pageOne} currentPage={1} eventsPerPage={1} search="" />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Metadata/i }));
    expect(metadataShown()).toBe(true);

    rerender(<RawTab items={pageTwo} currentPage={2} eventsPerPage={1} search="" />);

    expect(screen.getByText(/Event #\s*2/)).toBeInTheDocument();
    expect(metadataShown()).toBe(false);
  });

  it('keeps the row expanded when the same event re-renders', () => {
    const { rerender } = render(
      <RawTab items={pageOne} currentPage={1} eventsPerPage={1} search="" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Metadata/i }));
    rerender(<RawTab items={pageOne} currentPage={1} eventsPerPage={1} search="" />);
    expect(metadataShown()).toBe(true);
  });
});

describe('RawTab — CLONE_SOURCETYPE badge (#87)', () => {
  it('says where a cloned event came from', () => {
    const cloned = makeItem('2024-01-15 user=alice', 1);
    cloned.event.clonedFrom = 'my_app';
    const { container } = render(
      <RawTab items={[cloned]} currentPage={1} eventsPerPage={10} search="" />,
    );
    expect(container.textContent).toContain('Cloned from my_app');
  });

  it('badges nothing on an ordinary event', () => {
    const { container } = render(
      <RawTab items={[makeItem('2024-01-15 user=alice', 1)]} currentPage={1} eventsPerPage={10} search="" />,
    );
    expect(container.textContent).not.toContain('Cloned from');
  });
});

// The disclosure toggles say whether they are open.
describe('RawTab — toggles announce their state (#335)', () => {
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  afterEach(() => {
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  });

  it('marks the metadata bar expanded or collapsed', () => {
    render(<RawTab items={pageOne} currentPage={1} eventsPerPage={1} search="" />);
    const toggle = screen.getByRole('button', { name: /Metadata/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks the full-event toggle expanded or collapsed', () => {
    // jsdom does no layout; report an overflowing body so the toggle renders.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 1000 });
    render(<RawTab items={pageOne} currentPage={1} eventsPerPage={1} search="" />);
    const toggle = screen.getByRole('button', { name: /Show full event/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /Show less/ })).toHaveAttribute('aria-expanded', 'true');
  });
});

// Metadata changes are measured against the run's own input only, never the
// live fields.
describe('RawTab — metadata baseline is the run (#335)', () => {
  const initial = useAppStore.getState();
  afterEach(() => { useAppStore.setState(initial, true); });

  it('compares against the result\'s input metadata, not the live fields', () => {
    const meta = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
    useAppStore.setState({
      metadata: { ...meta, host: 'edited-since' },
      processingResult: { events: [pageOne[0]!.event], originalRaw: 'first event', eventCount: 1, stepSummaries: [], fieldStats: EMPTY_FIELD_STATS, inputMetadata: meta },
    });
    const { container } = render(<RawTab items={pageOne} currentPage={1} eventsPerPage={1} search="" />);
    expect(container.textContent).not.toContain('Metadata modified');
  });

  it('flags nothing when there is no result to compare against', () => {
    useAppStore.setState({ metadata: { index: 'other', host: 'x', source: 'y', sourcetype: 'z' }, processingResult: null });
    const { container } = render(<RawTab items={pageOne} currentPage={1} eventsPerPage={1} search="" />);
    expect(container.textContent).not.toContain('Metadata modified');
  });
});

// A CLONE_SOURCETYPE copy keeps its original's lineNumbers and sits right
// after it, so a key made of lines alone was shared by the two.
describe('RawTab — a clone and its original are separate rows (#422)', () => {
  afterEach(() => vi.restoreAllMocks());

  function cloneOf(item: EnrichedEvent, sourcetype: string): EnrichedEvent {
    const event = { ...item.event, metadata: { ...item.event.metadata, sourcetype }, clonedFrom: item.event.metadata.sourcetype };
    return { ...item, event };
  }

  it('renders both without a duplicate-key warning', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = makeItem('user=alice', 1);
    const items = [original, cloneOf(original, 'copy'), cloneOf(original, 'copy')];
    const { container } = render(<RawTab items={items} currentPage={1} eventsPerPage={10} search="" />);
    expect(screen.getAllByText(/^Event #\d+$/)).toHaveLength(3);
    expect(container.textContent.match(/Cloned from st/g)).toHaveLength(2);
    const sameKey = errors.mock.calls.filter((args: unknown[]) => args.some((a) => String(a).includes('same key')));
    expect(sameKey).toEqual([]);
  });

  it('keeps expanded state on the row it was set on', () => {
    const original = makeItem('user=alice', 1);
    const clone = cloneOf(original, 'copy');
    const { rerender } = render(<RawTab items={[original, clone]} currentPage={1} eventsPerPage={10} search="" />);
    fireEvent.click(screen.getAllByRole('button', { name: /Metadata/i })[1]!);
    // Reordered, the expanded state moves with the clone, not the slot.
    rerender(<RawTab items={[clone, original]} currentPage={1} eventsPerPage={10} search="" />);
    const toggles = screen.getAllByRole('button', { name: /Metadata/i });
    expect(toggles.map((b) => b.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  });

  it('clears the token selection when the same event\'s _raw changes', () => {
    const { rerender } = render(<RawTab items={[makeItem('user=alice', 1)]} currentPage={1} eventsPerPage={10} search="" />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowRight' });
    expect(document.body.textContent).toContain('Selected: user');
    rerender(<RawTab items={[makeItem('name=bob', 1)]} currentPage={1} eventsPerPage={10} search="" />);
    expect(document.body.textContent).not.toContain('Selected:');
  });
});

// Read from structured step fields, not step prose: the preview's traces carry
// no descriptions (see toViewResult).
describe('RawTab — metadata attribution and truncation from structured steps', () => {
  const initial = useAppStore.getState();
  afterEach(() => { useAppStore.setState(initial, true); });

  function itemWith(trace: SplunkEvent['processingTrace']): EnrichedEvent {
    const item = makeItem('GET /a 200', 1);
    item.event.metadata = { ...item.event.metadata, host: 'web02' };
    item.event.processingTrace = trace;
    item.hasMetadataChanges = true;
    return item;
  }

  it('names the step that last set the metadata key', () => {
    const meta = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
    useAppStore.setState({
      processingResult: { events: [], originalRaw: '', eventCount: 0, stepSummaries: [], fieldStats: EMPTY_FIELD_STATS, inputMetadata: meta },
    });
    const item = itemWith([
      { processor: 'TRANSFORMS-a:first_host', phase: 'index-time', description: '', metadataChanges: [{ key: 'host', from: 'h', to: 'web01' }] },
      { processor: 'TRANSFORMS-a:set_index', phase: 'index-time', description: '', metadataChanges: [{ key: 'index', from: 'main', to: 'main' }] },
      { processor: 'TRANSFORMS-a:last_host', phase: 'index-time', description: '', metadataChanges: [{ key: 'host', from: 'web01', to: 'web02' }] },
    ]);
    render(<RawTab items={[item]} currentPage={1} eventsPerPage={1} search="" />);
    fireEvent.click(screen.getByRole('button', { name: /Metadata/i }));
    expect(screen.getByText('[last_host]')).toBeInTheDocument();
    expect(screen.queryByText('[first_host]')).toBeNull();
  });

  it('badges a truncated event and says whether the limit was the default', () => {
    const item = makeItem('x'.repeat(20), 1);
    item.event.processingTrace = [
      { processor: 'truncator', phase: 'index-time', truncation: { lines: 2, limitBytes: 10000, isDefault: true } },
    ];
    const { rerender } = render(<RawTab items={[item]} currentPage={1} eventsPerPage={1} search="" />);
    const badge = screen.getByText('Truncated (default)');
    expect(badge).toHaveAttribute('title', 'Truncated 2 lines to 10000 bytes each (TRUNCATE default)');

    const configured = makeItem('x'.repeat(20), 1);
    configured.event.processingTrace = [
      { processor: 'truncator', phase: 'index-time', truncation: { lines: 1, limitBytes: 5, isDefault: false } },
    ];
    rerender(<RawTab items={[configured]} currentPage={1} eventsPerPage={1} search="" />);
    expect(screen.getByText('Truncated')).toHaveAttribute('title', 'Truncated 1 line to 5 bytes each (TRUNCATE=5)');
  });
});
