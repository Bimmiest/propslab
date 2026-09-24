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

  it('announces whether the strptime reference is expanded (#320)', () => {
    render(<TimestampTab items={items} currentPage={1} eventsPerPage={10} />);
    const toggle = screen.getByRole('button', { name: 'STRPTIME Reference' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
