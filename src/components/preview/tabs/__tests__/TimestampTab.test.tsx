// @vitest-environment jsdom
// The Timestamp tab draws highlights beside `_time` badges from the last
// pipeline run, so its config has to be the one that run used (#316), and its
// reference disclosure has to announce its state (#320).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TimestampTab } from '../TimestampTab';
import { useAppStore } from '../../../../store/useAppStore';
import type { EnrichedEvent } from '../../PreviewPanel';

const initial = useAppStore.getState();

const item: EnrichedEvent = {
  event: {
    _raw: 'ts=2026-01-15 msg',
    _time: new Date('2026-01-15T00:00:00.000Z'),
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  },
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
  });
  afterEach(() => vi.useRealTimers());

  it('in manual-apply mode, keeps the applied config until the pipeline is run (#316)', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    expect(shownFormat()).toBe('%Y-%m-%d');

    act(() => useAppStore.getState().setPropsConf(conf('%Y')));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(shownFormat()).toBe('%Y-%m-%d');

    act(() => useAppStore.getState().triggerManualRun());
    expect(shownFormat()).toBe('%Y');
  });

  it('in auto mode, follows the editor after the pipeline debounce, not per keystroke (#316)', () => {
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    act(() => useAppStore.getState().setPropsConf(conf('%Y')));
    expect(shownFormat()).toBe('%Y-%m-%d');
    act(() => {
      vi.advanceTimersByTime(300);
    });
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
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    expect(shownFormat()).toBe('%Y-%m-%d');
  });

  it('reads an empty TIME_PREFIX as not set (#328)', () => {
    useAppStore.setState({ propsConf: '[st]\nTIME_PREFIX =\nTIME_FORMAT = %Y-%m-%d\n' });
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    expect(screen.getByText(/^TIME_PREFIX=/)).toHaveTextContent('not set');
  });

  it('probes the text the extractor read, not a _raw SEDCMD rewrote after it (#328)', async () => {
    // The issue's repro: SEDCMD masks the very prefix TIME_PREFIX anchors on,
    // after the extractor has read the timestamp through it.
    useAppStore.setState({
      propsConf: '[st]\nTIME_PREFIX = host=\\S+\\s\nTIME_FORMAT = %Y-%m-%d %H:%M:%S\nSEDCMD-mask = s/host=\\S+ //\n',
    });
    const time = new Date('2026-01-15T10:00:00.000Z');
    const rewritten: EnrichedEvent = {
      ...item,
      event: {
        ...item.event,
        _raw: '2026-01-15 10:00:00 login',
        _time: time,
        timestampText: 'host=web01 2026-01-15 10:00:00 login',
        processingTrace: [
          { processor: 'timestampExtractor', phase: 'index-time', description: 'Extracted', timeSource: 'TIME_FORMAT' },
        ],
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
