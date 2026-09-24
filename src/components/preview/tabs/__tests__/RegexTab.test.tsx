// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { useAppStore } from '../../../../store/useAppStore';
import { RegexTab } from '../RegexTab';
import type { EnrichedEvent } from '../../PreviewPanel';
import type { SplunkEvent } from '../../../../engine/types';
import { matchInputs } from '../../../../engine/regexMatch';
import type { RegexMatchRequest, RegexMatchResponse } from '../../../../engine/regexMatchWorker';

function makeEvent(raw: string): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

function makeItem(raw: string): EnrichedEvent {
  return {
    event: makeEvent(raw),
    originalRaw: raw,
    hasChanges: false,
    hasMetadataChanges: false,
    isDropped: false,
  };
}

const items: EnrichedEvent[] = [
  makeItem('192.168.1.1 - GET /foo 200'),
  makeItem('10.0.0.5 - POST /bar 404'),
  makeItem('no ip here, just text'),
];

describe('RegexTab', () => {
  it('renders empty-state prompt when no pattern is typed', () => {
    render(<RegexTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    expect(screen.getByText(/Enter a pattern above to test matches/i)).toBeInTheDocument();
    // No event cards
    expect(screen.queryByText(/Event #/)).not.toBeInTheDocument();
  });

  it('renders only matching events when pattern is typed', async () => {
    render(<RegexTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    const input = screen.getByPlaceholderText(/\\d\+/);
    fireEvent.change(input, { target: { value: '\\d+\\.\\d+\\.\\d+\\.\\d+' } });

    // Matching is debounced and runs off the render path, so wait for it.
    // Only two events match (third has no IP).
    const cards = await screen.findAllByText(/Event #/);
    expect(cards).toHaveLength(2);
    expect(screen.getByText('2/3 events matched')).toBeInTheDocument();
  });

  it('shows "No events matched" when pattern is valid but has no hits', async () => {
    render(<RegexTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    const input = screen.getByPlaceholderText(/\\d\+/);
    fireEvent.change(input, { target: { value: 'this_text_does_not_appear' } });

    expect(await screen.findByText(/No events matched/i)).toBeInTheDocument();
    expect(screen.queryByText(/Event #/)).not.toBeInTheDocument();
  });

  it('surfaces validation error for invalid regex', () => {
    render(<RegexTab items={items} allEvents={items} currentPage={1} eventsPerPage={10} />);
    const input = screen.getByPlaceholderText(/\\d\+/);
    fireEvent.change(input, { target: { value: '[unterminated' } });

    expect(screen.getByText(/Fix the regex error above/i)).toBeInTheDocument();
  });
});

const initialState = useAppStore.getState();
const defaultProps = { items, allEvents: items, currentPage: 1, eventsPerPage: 10 };

describe('RegexTab — one-click Add to props.conf (#88)', () => {
  function setup(sourcetype: string) {
    useAppStore.setState(initialState, true);
    useAppStore.setState({
      metadata: { index: 'main', host: 'h', source: 's', sourcetype },
      propsConf: sourcetype ? `[${sourcetype}]\nSHOULD_LINEMERGE = false\n` : '',
    });
  }

  function typePattern(container: HTMLElement, pattern: string) {
    // Same handle the tests above use: the label is not wired to the input.
    const input = within(container).getByPlaceholderText(/\\d\+/);
    fireEvent.change(input, { target: { value: pattern } });
  }

  it('upserts the directive into the event sourcetype stanza', () => {
    setup('my_app');
    const { container } = render(<RegexTab {...defaultProps} />);
    typePattern(container, 'user=(?<user>\\w+)');

    fireEvent.click(within(container).getByRole('button', { name: 'Add to props.conf' }));

    const props = useAppStore.getState().propsConf;
    expect(props).toContain('EXTRACT-');
    expect(props).toContain('user=(?<user>\\w+)');
    // Upserted into the existing stanza rather than appending a second one.
    expect(props.match(/\[my_app\]/g)).toHaveLength(1);
    expect(props).toContain('SHOULD_LINEMERGE = false');
  });

  it('points the metadata at the placeholder stanza when there is no sourcetype', () => {
    // Writing [my:sourcetype] alone produces config that can never match the
    // event it was scaffolded from (#72).
    setup('');
    const { container } = render(<RegexTab {...defaultProps} />);
    typePattern(container, 'user=(?<user>\\w+)');

    fireEvent.click(within(container).getByRole('button', { name: 'Add to props.conf' }));

    expect(useAppStore.getState().propsConf).toContain('[my:sourcetype]');
    expect(useAppStore.getState().metadata.sourcetype).toBe('my:sourcetype');
  });

  it('warns before the click that the sourcetype will be set', () => {
    setup('');
    const { container } = render(<RegexTab {...defaultProps} />);
    typePattern(container, 'user=(?<user>\\w+)');
    expect(container.textContent).toContain('This event has no sourcetype');
  });

  it('says nothing about the sourcetype when the event has one', () => {
    setup('my_app');
    const { container } = render(<RegexTab {...defaultProps} />);
    typePattern(container, 'user=(?<user>\\w+)');
    expect(container.textContent).not.toContain('This event has no sourcetype');
  });

  it('offers no button until there is a valid pattern', () => {
    setup('my_app');
    const { container } = render(<RegexTab {...defaultProps} />);
    expect(within(container).queryByRole('button', { name: 'Add to props.conf' })).not.toBeInTheDocument();

    typePattern(container, '(unbalanced');
    expect(within(container).queryByRole('button', { name: 'Add to props.conf' })).not.toBeInTheDocument();
  });
});

describe('RegexTab — results follow the typed pattern (#315)', () => {
  it('treats the previous pattern\'s results as pending until the new one is matched', async () => {
    useAppStore.setState(initialState, true);
    const { container } = render(<RegexTab {...defaultProps} />);
    const input = within(container).getByPlaceholderText(/\\d\+/);

    fireEvent.change(input, { target: { value: '\\d+\\.\\d+\\.\\d+\\.\\d+' } });
    expect(await within(container).findAllByText(/Event #/)).toHaveLength(2);
    expect(within(container).getByText('2/3 events matched')).toBeInTheDocument();

    // Inside the debounce window the old results must not be shown as the
    // new pattern's — the "Add to props.conf" button already writes this one.
    fireEvent.change(input, { target: { value: 'this_text_does_not_appear' } });
    expect(within(container).queryByText(/Event #/)).not.toBeInTheDocument();
    expect(within(container).queryByText(/events matched/)).not.toBeInTheDocument();
    expect(within(container).getByText('Testing pattern…')).toBeInTheDocument();
    expect(within(container).getByRole('button', { name: 'Add to props.conf' })).toBeInTheDocument();

    expect(await within(container).findByText('No events matched')).toBeInTheDocument();
    expect(within(container).getByText('0/3 events matched')).toBeInTheDocument();
  });
});

describe('RegexTab — reference keyboard access (#320)', () => {
  it('announces the reference disclosure state', () => {
    render(<RegexTab {...defaultProps} />);
    const toggle = screen.getByRole('button', { name: 'Regex Reference' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('inserts a reference pattern from its button', () => {
    render(<RegexTab {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regex Reference' }));
    const input = screen.getByPlaceholderText(/\\d\+/);

    // A native button: Enter and Space activate it as a click.
    const append = screen.getByRole('button', { name: 'Append \\d' });
    expect(append.tagName).toBe('BUTTON');
    fireEvent.click(append);
    expect(input).toHaveValue('\\d');
    fireEvent.click(append);
    expect(input).toHaveValue('\\d\\d');

    fireEvent.click(screen.getByRole('button', { name: 'Use pattern (?P<pid>\\d+)' }));
    expect(input).toHaveValue('(?P<pid>\\d+)');
  });

  it('still inserts once when the row itself is clicked', () => {
    render(<RegexTab {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regex Reference' }));
    const input = screen.getByPlaceholderText(/\\d\+/);
    fireEvent.click(screen.getByText('Whitespace'));
    expect(input).toHaveValue('\\s');
  });
});

// #335: the reference rows were themselves role="button", which dropped their
// row and cell semantics, and their aria-label hid the description cell.
describe('RegexTab — reference table semantics (#335)', () => {
  it('keeps rows as rows and describes each button by its description cell', () => {
    render(<RegexTab {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regex Reference' }));

    const button = screen.getByRole('button', { name: 'Append \\d' });
    expect(button).toHaveAccessibleDescription('Digit (0-9)');

    const row = button.closest('tr')!;
    expect(row).not.toHaveAttribute('role');
    expect(row).not.toHaveAttribute('aria-label');
    expect(within(row).getAllByRole('cell')).toHaveLength(3);
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });
});

describe('RegexTab — timers (#322)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('clears the confirmation-label timers when it unmounts', async () => {
    useAppStore.setState(initialState, true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    useAppStore.setState({ metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'my_app' } });
    // The labels' 1.5 s timers, told apart from the debounce and React's own.
    const labelTimers: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const id = realSetTimeout(fn, ms);
      if (ms === 1500) labelTimers.push(id);
      return id;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { container, unmount } = render(<RegexTab {...defaultProps} />);
    fireEvent.change(within(container).getByPlaceholderText(/\\d\+/), { target: { value: 'GET' } });
    fireEvent.click(within(container).getByRole('button', { name: 'Copy' }));
    expect(await within(container).findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    fireEvent.click(within(container).getByRole('button', { name: 'Add to props.conf' }));
    expect(within(container).getByRole('button', { name: 'Added!' })).toBeInTheDocument();
    expect(labelTimers).toHaveLength(2);

    unmount();
    for (const id of labelTimers) expect(clearSpy).toHaveBeenCalledWith(id);
  });
});

// #329: pending was keyed on the pattern alone. When `allEvents` changed — a
// pipeline re-run, a search keystroke — the first commit indexed the previous
// events' results into the new events by position, then the whole list flipped
// to "Testing pattern…" until the re-run answered. Driven through a fake worker
// so the re-run can be held in flight.
describe('RegexTab — results follow the events they were matched over (#329)', () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((e: MessageEvent<RegexMatchResponse>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    posted: RegexMatchRequest[] = [];
    constructor() { FakeWorker.instances.push(this); }
    postMessage(message: RegexMatchRequest) { this.posted.push(message); }
    terminate() {}
    respond() {
      const req = this.posted[this.posted.length - 1]!;
      this.onmessage?.({ data: { id: req.id, results: matchInputs(req.pattern, req.inputs) } } as MessageEvent<RegexMatchResponse>);
    }
  }
  const worker = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;

  beforeEach(() => {
    useAppStore.setState(initialState, true);
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const cardTitles = (container: HTMLElement) =>
    within(container).queryAllByText(/^Event #\d+$/).map((el) => el.textContent);

  it('keeps showing the previous results against their own events while the new ones are matched', () => {
    const { container, rerender } = render(<RegexTab {...defaultProps} />);
    fireEvent.change(within(container).getByPlaceholderText(/\\d\+/), { target: { value: '\\d+\\.\\d+\\.\\d+\\.\\d+' } });
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { worker().respond(); });
    expect(cardTitles(container)).toEqual(['Event #1', 'Event #2']);
    expect(within(container).getByText('2/3 events matched')).toBeInTheDocument();

    // A re-run reorders and grows the dataset; the IP events move to #3 and #4.
    const next = [makeItem('no ip here'), makeItem('still none'), items[1]!, items[0]!];
    rerender(<RegexTab items={next} allEvents={next} currentPage={1} eventsPerPage={10} />);

    // Not flashed to pending, and not the old results laid over the new events
    // (which would badge "no ip here" as Event #1, matched).
    expect(within(container).queryByText('Testing pattern…')).not.toBeInTheDocument();
    expect(cardTitles(container)).toEqual(['Event #1', 'Event #2']);
    expect(container.textContent).toContain('192.168.1.1 - GET /foo 200');
    expect(container.textContent).not.toContain('no ip here');
    expect(within(container).getByText(/2\/3 events matched/).textContent).toContain('updating');

    act(() => { worker().respond(); });
    expect(cardTitles(container)).toEqual(['Event #3', 'Event #4']);
    expect(within(container).getByText('2/4 events matched')).toBeInTheDocument();
    expect(container.textContent).not.toContain('updating');
  });

  it('shows the timeout, not stale results, when the re-run is stopped', () => {
    const { container, rerender } = render(<RegexTab {...defaultProps} />);
    fireEvent.change(within(container).getByPlaceholderText(/\\d\+/), { target: { value: 'GET' } });
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { worker().respond(); });
    expect(cardTitles(container)).toEqual(['Event #1']);

    const next = [...items, makeItem('GET /again')];
    rerender(<RegexTab items={next} allEvents={next} currentPage={1} eventsPerPage={10} />);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(within(container).getByText(/too slow to evaluate/)).toBeInTheDocument();
    expect(cardTitles(container)).toEqual([]);
  });
});
