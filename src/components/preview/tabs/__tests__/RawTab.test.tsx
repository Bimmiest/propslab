// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useAppStore } from '../../../../store/useAppStore';
import { RawTab } from '../RawTab';
import type { EnrichedEvent } from '../../PreviewPanel';
import type { SplunkEvent } from '../../../../engine/types';

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
  return { event, originalRaw: raw, hasChanges: false, hasMetadataChanges: false, isDropped: false };
}

const pageOne = [makeItem('first event', 1)];
const pageTwo = [makeItem('second event', 2)];

// The expanded metadata bar renders `sourcetype=…`; the label and value live in
// separate elements, so match against the flattened text rather than a node.
const metadataShown = () => document.body.textContent?.includes('sourcetype') === true;

// #23: EventRow holds expand/selection state locally. Keying rows by their slot
// on the page let React reuse the instance across a page change, so one event's
// expanded state appeared on a different event.
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

// #335: the disclosure toggles did not say whether they were open.
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

// #335: metadata changes are measured against the run's own input only. The
// fallback to the live fields was unreachable with a result, and with none it
// badged events against whatever the fields held.
describe('RawTab — metadata baseline is the run (#335)', () => {
  const initial = useAppStore.getState();
  afterEach(() => { useAppStore.setState(initial, true); });

  it('compares against the result\'s input metadata, not the live fields', () => {
    const meta = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
    useAppStore.setState({
      metadata: { ...meta, host: 'edited-since' },
      processingResult: { events: [pageOne[0]!.event], originalRaw: 'first event', eventCount: 1, processingSteps: [], inputMetadata: meta },
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
