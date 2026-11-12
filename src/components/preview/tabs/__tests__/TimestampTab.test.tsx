// @vitest-environment jsdom
// The Timestamp tab draws highlights beside `_time` badges from the last
// pipeline run, so its config has to be the one that run used, and its
// reference disclosure has to announce its state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Profiler } from 'react';
import { TimestampTab } from '../timestamp';
import { useAppStore } from '../../../../store/useAppStore';
import type { EnrichedEvent } from '../../enrichEvents';
import { makeEvent } from '../../../../test/makeEvent';
import { answerRun } from '../../../../test/answerRun';

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
