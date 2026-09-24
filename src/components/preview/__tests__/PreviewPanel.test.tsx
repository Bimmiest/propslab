// @vitest-environment jsdom
// A run that failed outright used to fall through to the first-run "No data
// yet" invitation (#294); it has to say that the run failed, and why.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PreviewPanel } from '../PreviewPanel';
import { useAppStore } from '../../../store/useAppStore';
import type { EventMetadata, ProcessingResult } from '../../../engine/types';

const initial = useAppStore.getState();

describe('PreviewPanel', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initial, activeOutputTab: 'preview' }, true);
  });

  it('invites input before anything has run', () => {
    render(<PreviewPanel />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('shows the failure, not the empty state, when a run produced no result', () => {
    useAppStore.setState({
      processingResult: null,
      validationDiagnostics: [{ level: 'error', message: 'Pipeline timed out after 5 s', file: 'props.conf' }],
    });
    render(<PreviewPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('Pipeline timed out after 5 s');
    expect(screen.queryByText('No data yet')).not.toBeInTheDocument();
  });

  it('wires the active tab and its panel to each other by per-instance ids', () => {
    // #300: ids were the global `tab-${id}`; two tablists (or two mounts of
    // one) could collide and point aria-controls at the wrong panel.
    render(<><PreviewPanel /><PreviewPanel /></>);
    const tabs = screen.getAllByRole('tab', { name: 'Preview' });
    const panels = screen.getAllByRole('tabpanel');
    expect(tabs[0]!.id).not.toBe(tabs[1]!.id);
    tabs.forEach((tab, i) => {
      expect(tab).toHaveAttribute('aria-controls', panels[i]!.id);
      expect(panels[i]).toHaveAttribute('aria-labelledby', tab.id);
    });
  });

  it('ignores warnings when there is no result', () => {
    useAppStore.setState({
      processingResult: null,
      validationDiagnostics: [{ level: 'warning', message: 'unused stanza', file: 'props.conf' }],
    });
    render(<PreviewPanel />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });
});

describe('PreviewPanel — metadata changes are relative to the run (#316)', () => {
  const runMeta: EventMetadata = { index: 'main', host: 'web01', source: '/var/log/app.log', sourcetype: 'app' };

  function resultWith(host: string): ProcessingResult {
    return {
      events: [{
        _raw: 'GET /index.html 200',
        _time: null,
        _meta: {},
        fields: {},
        metadata: { ...runMeta, host },
        lineNumbers: { start: 1, end: 1 },
        processingTrace: [],
      }],
      originalRaw: 'GET /index.html 200',
      eventCount: 1,
      processingSteps: [],
      inputMetadata: runMeta,
    };
  }

  function metadataModifiedCount(): string | null {
    fireEvent.click(screen.getByRole('button', { name: /Changes/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Metadata Modified' }));
    return screen.getByText(/^\d+ \/ \d+$/).textContent;
  }

  beforeEach(() => {
    useAppStore.setState({ ...initial, activeOutputTab: 'preview' }, true);
  });

  it('does not flag events when the metadata is edited after the run', () => {
    useAppStore.setState({ metadata: runMeta, processingResult: resultWith('web01') });
    render(<PreviewPanel />);
    // Typing a new host (manual-apply: no run follows) is not a change the
    // pipeline made to these events.
    act(() => { useAppStore.getState().setMetadataField('host', 'web02'); });
    expect(metadataModifiedCount()).toBe('0 / 1');
  });

  it('still flags an event whose metadata the run rewrote', () => {
    useAppStore.setState({ metadata: runMeta, processingResult: resultWith('rewritten') });
    render(<PreviewPanel />);
    expect(metadataModifiedCount()).toBe('1 / 1');
  });
});

// #335: each keystroke in the preview search rebuilt `filteredEvents`, which
// re-scanned every event and re-posted the whole dataset to the Regex tab's
// matcher. The filter now follows a debounced copy; the input does not wait.
describe('PreviewPanel — search is debounced (#335)', () => {
  function resultOf(raws: string[]): ProcessingResult {
    const meta: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
    return {
      events: raws.map((raw, i) => ({
        _raw: raw,
        _time: null,
        _meta: {},
        fields: {},
        metadata: meta,
        lineNumbers: { start: i + 1, end: i + 1 },
        processingTrace: [],
      })),
      originalRaw: raws.join('\n'),
      eventCount: raws.length,
      processingSteps: [],
      inputMetadata: meta,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState({ ...initial, activeOutputTab: 'preview', processingResult: resultOf(['GET /a 200', 'POST /b 500', 'GET /c 404']) }, true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the input live but filters once typing pauses', () => {
    const { container } = render(<PreviewPanel />);
    const input = screen.getByRole('textbox', { name: 'Search events' });

    fireEvent.change(input, { target: { value: 'G' } });
    fireEvent.change(input, { target: { value: 'GET' } });
    expect(input).toHaveValue('GET');
    // Not filtered per keystroke.
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(container.textContent).toContain('POST /b 500');

    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(container.textContent).not.toContain('POST /b 500');
  });
});
