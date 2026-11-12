// @vitest-environment jsdom
// The Timestamp tab draws highlights beside `_time` badges from the last
// pipeline run, so its config has to be the one that run used, and its
// reference disclosure has to announce its state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { Profiler } from 'react';
import { TimestampTab } from '../timestamp';
import { useAppStore } from '../../../../store/useAppStore';
import type { EnrichedEvent } from '../../enrichEvents';
import { makeEvent } from '../../../../test/makeEvent';
import { extractTimestamps } from '../../../../engine/processors/timestampExtractor';
import { runCtx } from '../../../../engine/__tests__/runCtx';
import type { ConfDirective, SplunkEvent } from '../../../../engine/types';
import { toViewResult } from '../../../../utils/viewResult';
import { answerRun } from '../../../../test/answerRun';

const dir = (key: string, value: string): ConfDirective => ({ key, value, line: 1, directiveType: key });

const initial = useAppStore.getState();

const item: EnrichedEvent = {
  event: makeEvent('ts=2026-01-15 msg', { _time: new Date('2026-01-15T00:00:00.000Z') }),
  searchText: 'ts=2026-01-15 msg',
  originalRaw: 'ts=2026-01-15 msg',
  hasChanges: false,
  hasMetadataChanges: false,
  isDropped: false,
};
const items = [item];

const conf = (format: string) => `[st]\nTIME_FORMAT = ${format}\n`;
const shownFormat = () => screen.getByText(/^TIME_FORMAT=/).querySelector('code')?.textContent;

describe('TimestampTab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(
      {
        ...initial,
        propsConf: conf('%Y-%m-%d'),
        metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      },
      true,
    );
    answerRun();
  });
  afterEach(() => vi.useRealTimers());

  it('in manual-apply mode, keeps the config of the run until another run answers (#316, #879)', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    expect(shownFormat()).toBe('%Y-%m-%d');

    act(() => useAppStore.getState().setPropsConf(conf('%Y')));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(shownFormat()).toBe('%Y-%m-%d');

    act(() => answerRun());
    expect(shownFormat()).toBe('%Y');
  });

  it('mounted after edits that did not run, shows the config of the run (#879)', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    act(() => useAppStore.getState().setPropsConf(conf('%Y')));
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    expect(shownFormat()).toBe('%Y-%m-%d');
  });

  it('in auto mode, keeps the config of the events on screen until the run answers (#316, #879)', () => {
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    act(() => useAppStore.getState().setPropsConf(conf('%Y')));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(shownFormat()).toBe('%Y-%m-%d');
    act(() => answerRun());
    expect(shownFormat()).toBe('%Y');
  });

  it('resolves an input-time sourcetype assignment the way the pipeline does (#328)', () => {
    // [source::s] assigns `assigned`, so the pipeline reads [assigned]'s
    // TIME_FORMAT; matchStanzas alone stopped at [st]'s.
    useAppStore.setState({
      propsConf: [
        '[source::s]',
        'sourcetype = assigned',
        '',
        '[st]',
        'TIME_FORMAT = %Y',
        '',
        '[assigned]',
        'TIME_FORMAT = %Y-%m-%d',
      ].join('\n'),
    });
    answerRun();
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    expect(shownFormat()).toBe('%Y-%m-%d');
  });

  it('reads an empty TIME_PREFIX as not set (#328)', () => {
    useAppStore.setState({ propsConf: '[st]\nTIME_PREFIX =\nTIME_FORMAT = %Y-%m-%d\n' });
    answerRun();
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    expect(screen.getByText(/^TIME_PREFIX=/)).toHaveTextContent('not set');
  });

  it('probes the text the extractor read, not a _raw SEDCMD rewrote after it (#328)', async () => {
    // The issue's repro: SEDCMD masks the very prefix TIME_PREFIX anchors on,
    // after the extractor has read the timestamp through it.
    useAppStore.setState({
      propsConf: '[st]\nTIME_PREFIX = host=\\S+\\s\nTIME_FORMAT = %Y-%m-%d %H:%M:%S\nSEDCMD-mask = s/host=\\S+ //\n',
    });
    answerRun();
    const time = new Date('2026-01-15T10:00:00.000Z');
    const rewritten: EnrichedEvent = {
      ...item,
      event: {
        ...item.event,
        _raw: '2026-01-15 10:00:00 login',
        _time: time,
        timestampText: 'host=web01 2026-01-15 10:00:00 login',
        processingTrace: [{ processor: 'timestampExtractor', phase: 'index-time', timeSource: 'TIME_FORMAT' }],
      },
    };
    render(<TimestampTab items={[rewritten]} currentPage={1} eventsPerPage={10} />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(screen.queryByText('No match')).not.toBeInTheDocument();
    expect(screen.getByText('host=web01')).toBeInTheDocument();
    expect(screen.getByText('2026-01-15 10:00:00')).toBeInTheDocument();
    expect(screen.getByText('as read before _raw was rewritten')).toBeInTheDocument();
  });

  it('announces whether the strptime reference is expanded (#320)', () => {
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    const toggle = screen.getByRole('button', { name: 'STRPTIME Reference' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('TimestampTab inputs (#565)', () => {
  it('does not re-render on a config keystroke, only when a run answers', () => {
    useAppStore.setState(
      {
        ...initial,
        propsConf: '[st]\nTIME_FORMAT = %Y-%m-%d',
        metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      },
      true,
    );
    answerRun();
    let renders = 0;
    render(
      <Profiler id="ts" onRender={() => renders++}>
        <TimestampTab items={items} currentPage={1} eventsPerPage={10} />
      </Profiler>,
    );
    const before = renders;
    act(() => useAppStore.getState().setPropsConf('[st]\nTIME_FORMAT = %d/%m/%Y'));
    expect(renders).toBe(before);
    act(() => answerRun());
    expect(renders).toBeGreaterThan(before);
  });
});

// With no TIME_FORMAT the tab shows what automatic recognition did, read from
// the run's trace (#898). The events come from the extractor itself.
describe('TimestampTab with no TIME_FORMAT (#898)', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const enrich = (event: SplunkEvent): EnrichedEvent => ({
    event,
    searchText: event._raw.toLowerCase(),
    originalRaw: event._raw,
    hasChanges: false,
    hasMetadataChanges: false,
    isDropped: false,
  });
  const run = (raws: string[], directives: ConfDirective[] = []) =>
    extractTimestamps(
      raws.map((raw) => makeEvent(raw)),
      directives,
      runCtx(now),
    ).map(enrich);
  const settle = () =>
    act(async () => {
      await vi.runAllTimersAsync();
    });
  const card = (n: number) => screen.getByText(`Event #${n}`).closest('[data-time-badge]') as HTMLElement;
  const legend = () => screen.queryByText('Lookahead boundary')?.closest('div');

  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(
      {
        ...initial,
        propsConf: '[st]\nSHOULD_LINEMERGE = false\n',
        metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      },
      true,
    );
    answerRun();
  });
  afterEach(() => vi.useRealTimers());

  it('names the recognised format and underlines each match beside its _time', async () => {
    const events = run(['1,2026/10/25 14:23:01,TRAFFIC', '1,2026/10/25 14:23:05,TRAFFIC']);
    render(<TimestampTab items={events} currentPage={1} eventsPerPage={10} />);
    await settle();

    const panel = screen.getByRole('region', { name: 'Automatic timestamp recognition' });
    expect(panel).toHaveTextContent('Auto-recognized timestamp format %Y/%m/%d %H:%M:%S (2 events)');
    expect(panel).toHaveTextContent('2 events recognized · 0 events with a _time not read from the event text');
    expect(screen.queryByText(/No TIME_FORMAT configured/)).not.toBeInTheDocument();

    const match = within(card(1)).getByTitle(
      /^Recognized format: %Y\/%m\/%d %H:%M:%S\s+Parsed: 2026-10-25T14:23:01\.000Z$/,
    );
    expect(match).toHaveTextContent(/^2026\/10\/25 14:23:01$/);
    expect(card(1)).toHaveAttribute('data-time-badge', 'read');
    expect(within(card(1)).getByText('2026-10-25T14:23:01.000Z')).toBeInTheDocument();
  });

  it('shows only the legend entries that are on screen', async () => {
    render(<TimestampTab items={run(['2026-10-25 14:23:01 a'])} currentPage={1} eventsPerPage={10} />);
    await settle();
    expect(legend()).toHaveTextContent('Recognized timestamp');
    expect(legend()).not.toHaveTextContent('TIME_PREFIX match');
    expect(legend()).not.toHaveTextContent('TIME_FORMAT match');
  });

  it('shows no legend when nothing on screen is marked', async () => {
    render(<TimestampTab items={run(['no time here'])} currentPage={1} eventsPerPage={10} />);
    await settle();
    expect(screen.queryByText('Lookahead boundary')).not.toBeInTheDocument();
    expect(screen.queryByText('Recognized timestamp')).not.toBeInTheDocument();
  });

  it('lists an event recognition failed on with the reason, not underlined', async () => {
    const events = run(['2026-10-25 14:23:01 a', 'no time here']);
    render(<TimestampTab items={events} currentPage={1} eventsPerPage={10} />);
    await settle();

    expect(screen.getByRole('region', { name: 'Automatic timestamp recognition' })).toHaveTextContent(
      '1 event recognized · 1 event with a _time not read from the event text',
    );
    expect(card(2)).toHaveAttribute('data-time-badge', 'fallback');
    expect(within(card(2)).getByText('No timestamp found — _time from the previous event')).toBeInTheDocument();
    expect(within(card(2)).getByText('2026-10-25T14:23:01.000Z')).toBeInTheDocument();
    expect(within(card(2)).queryByTitle(/^Recognized format/)).not.toBeInTheDocument();
  });

  it('heads with the most common format, lists the others, and marks the events that used them', async () => {
    const events = run(['2026-10-25 14:23:01 a', '25/Oct/2026:14:23:02 b', '2026-10-25 14:23:03 c']);
    render(<TimestampTab items={events} currentPage={1} eventsPerPage={10} />);
    await settle();

    const panel = screen.getByRole('region', { name: 'Automatic timestamp recognition' });
    expect(panel).toHaveTextContent('Auto-recognized timestamp format %Y-%m-%d %H:%M:%S (2 events)');
    expect(panel).toHaveTextContent('Also recognized: %d/%b/%Y:%H:%M:%S (1 event)');
    expect(within(panel).getByTestId('time-format-directives')).toHaveTextContent('TIME_FORMAT = %Y-%m-%d %H:%M:%S');
    expect(within(card(2)).getByText('%d/%b/%Y:%H:%M:%S')).toBeInTheDocument();
    expect(within(card(1)).queryByText('%Y-%m-%d %H:%M:%S')).not.toBeInTheDocument();
  });

  it('counts the whole run, not only the page', async () => {
    const events = extractTimestamps(
      ['2026-10-25 14:23:01 a', 'none', '2026-10-25 14:23:03 c'].map((raw) => makeEvent(raw)),
      [],
      runCtx(now),
    );
    useAppStore.setState({
      processingResult: toViewResult({
        events,
        originalRaw: '',
        eventCount: events.length,
        processingSteps: [],
        inputMetadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      }),
    });
    answerRun();
    render(<TimestampTab items={events.slice(0, 1).map(enrich)} currentPage={1} eventsPerPage={1} />);
    await settle();
    expect(screen.getByRole('region', { name: 'Automatic timestamp recognition' })).toHaveTextContent(
      '2 events recognized · 1 event with a _time not read from the event text',
    );
  });

  it('writes TIME_PREFIX, TIME_FORMAT and MAX_TIMESTAMP_LOOKAHEAD into the stanza that applies', async () => {
    render(<TimestampTab items={run(['1,2026/10/25 14:23:01,TRAFFIC'])} currentPage={1} eventsPerPage={10} />);
    await settle();
    expect(screen.getByText('[st]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Write this as TIME_FORMAT' }));
    expect(useAppStore.getState().propsConf).toBe(
      '[st]\nSHOULD_LINEMERGE = false\nTIME_PREFIX = ,\nTIME_FORMAT = %Y/%m/%d %H:%M:%S\nMAX_TIMESTAMP_LOOKAHEAD = 20\n',
    );
  });

  it('keeps a TIME_PREFIX that is set, and writes TIME_FORMAT alone', async () => {
    useAppStore.setState({ propsConf: '[st]\nTIME_PREFIX = ts=\n' });
    answerRun();
    const events = run(['id ts=2026-10-25 14:23:01 x'], [dir('TIME_PREFIX', 'ts=')]);
    render(<TimestampTab items={events} currentPage={1} eventsPerPage={10} />);
    await settle();
    expect(legend()).toHaveTextContent('TIME_PREFIX match');
    expect(within(card(1)).getByTitle('TIME_PREFIX: ts=')).toHaveTextContent('ts=');
    fireEvent.click(screen.getByRole('button', { name: 'Write this as TIME_FORMAT' }));
    expect(useAppStore.getState().propsConf).toBe('[st]\nTIME_PREFIX = ts=\nTIME_FORMAT = %Y-%m-%d %H:%M:%S\n');
  });

  it('offers no button when no event was recognised', async () => {
    render(<TimestampTab items={run(['no time', 'none either'])} currentPage={1} eventsPerPage={10} />);
    await settle();
    expect(screen.getByRole('region', { name: 'Automatic timestamp recognition' })).toHaveTextContent(
      'No TIME_FORMAT is set, and automatic recognition found no timestamp in any event.',
    );
    expect(screen.queryByRole('button', { name: 'Write this as TIME_FORMAT' })).not.toBeInTheDocument();
    expect(within(card(1)).getByText('No timestamp found — _time from the time of indexing')).toBeInTheDocument();
  });

  it('shows no recognition panel when TIME_FORMAT is set, and names the match TIME_FORMAT in the legend', async () => {
    useAppStore.setState({ propsConf: '[st]\nTIME_FORMAT = %Y-%m-%d\n' });
    answerRun();
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    await settle();
    expect(screen.queryByRole('region', { name: 'Automatic timestamp recognition' })).not.toBeInTheDocument();
    expect(legend()).toHaveTextContent('TIME_FORMAT match');
    expect(legend()).not.toHaveTextContent('TIME_PREFIX match');
  });
});
