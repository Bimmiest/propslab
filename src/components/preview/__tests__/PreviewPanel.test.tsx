// @vitest-environment jsdom
// A run that failed outright has to say that it failed, and why, rather than
// show the first-run "No data yet" invitation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PreviewPanel } from '../PreviewPanel';
import { useAppStore, selectSessionDirty } from '../../../store/useAppStore';
import { SAMPLE_CONFIGS } from '../../../engine/sampleData';
import type { EventMetadata } from '../../../engine/types';
import { toViewResult, type ViewResult } from '../../../utils/viewResult';

const initial = useAppStore.getState();

describe('PreviewPanel', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initial, activeOutputTab: 'preview' }, true);
  });

  it('invites input before anything has run', () => {
    render(<PreviewPanel />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('tells a manual-apply user to press Run, and only then (#492)', () => {
    const { unmount } = render(<PreviewPanel />);
    expect(screen.queryByText(/press Run/)).not.toBeInTheDocument();
    unmount();

    act(() => useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } }));
    render(<PreviewPanel />);
    expect(screen.getByText(/press Run/)).toBeInTheDocument();
  });

  it('runs an example loaded from the empty state in manual-apply mode (#492)', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    render(<PreviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Apache Access Log/ }));
    expect(useAppStore.getState().manualRunTick).toBe(1);
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
    // Ids are per-tablist, so two tablists (or two mounts of one) cannot
    // collide and point aria-controls at the wrong panel.
    render(<><PreviewPanel /><PreviewPanel /></>);
    const tabs = screen.getAllByRole('tab', { name: 'Preview' });
    const panels = screen.getAllByRole('tabpanel');
    expect(tabs[0]!.id).not.toBe(tabs[1]!.id);
    tabs.forEach((tab, i) => {
      expect(tab).toHaveAttribute('aria-controls', panels[i]!.id);
      expect(panels[i]).toHaveAttribute('aria-labelledby', tab.id);
    });
  });

  // Loaded through loadInputs, so the example is the clean baseline: an
  // unedited example is not work the command palette should warn about.
  it('loads an example from the empty state as a clean session', () => {
    render(<PreviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Apache Access Log/ }));
    const state = useAppStore.getState();
    expect(state.rawData).toBe(SAMPLE_CONFIGS[0]!.rawData);
    expect(state.metadata).toEqual(SAMPLE_CONFIGS[0]!.metadata);
    expect(selectSessionDirty(state)).toBe(false);

    act(() => state.setPropsConf(`${state.propsConf}\n# edited`));
    expect(selectSessionDirty(useAppStore.getState())).toBe(true);
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

  function resultWith(host: string): ViewResult {
    return toViewResult({
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
    });
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

// The filter follows a debounced copy of the preview search, so a keystroke
// does not rebuild `filteredEvents` (a scan of every event and a re-post of the
// dataset to the Regex tab's matcher); the input does not wait.
describe('PreviewPanel — search is debounced (#335)', () => {
  function resultOf(raws: string[]): ViewResult {
    const meta: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
    return toViewResult({
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
    });
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

// The Effective config tab unmounts while another output tab is shown,
// which is when props.conf gets edited, so the inputs of the last run are held
// by the panel rather than the tab.
describe('PreviewPanel — Effective config shows the last run in manual-apply mode (#347)', () => {
  beforeEach(() => {
    useAppStore.setState(
      {
        ...initial,
        activeOutputTab: 'architecture',
        settings: { perEventPipeline: false, manualApply: true },
        metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
        propsConf: '[st]\nTRUNCATE = 500\n',
      },
      true,
    );
  });

  it('keeps the run config across edits made while the tab was hidden', () => {
    render(<PreviewPanel />);
    act(() => useAppStore.getState().setPropsConf('[st]\nTRUNCATE = 123\n'));
    act(() => useAppStore.getState().setActiveOutputTab('effective'));
    expect(screen.getByText('= 500')).toBeInTheDocument();
    expect(screen.queryByText('= 123')).not.toBeInTheDocument();

    act(() => useAppStore.getState().triggerManualRun());
    expect(screen.getByText('= 123')).toBeInTheDocument();
  });
});

// The change check strips trailing whitespace on the main thread for every
// event, and /\s+$/ backtracks quadratically over a long run of whitespace
// that is not at the end.
describe('PreviewPanel — the change check is linear in whitespace (#427)', () => {
  const meta: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
  function resultOf(raw: string, originalRaw: string): ViewResult {
    return toViewResult({
      events: [{
        _raw: raw,
        _time: null,
        _meta: {},
        fields: {},
        metadata: meta,
        lineNumbers: { start: 1, end: 1 },
        processingTrace: [],
      }],
      originalRaw,
      eventCount: 1,
      processingSteps: [],
      inputMetadata: meta,
    });
  }

  function unmodifiedCount(): string | null {
    fireEvent.click(screen.getByRole('button', { name: /Changes/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unmodified' }));
    return screen.getByText(/^\d+ \/ \d+$/).textContent;
  }

  beforeEach(() => {
    useAppStore.setState({ ...initial, activeOutputTab: 'preview' }, true);
  });

  it('ignores CRLF and trailing whitespace when deciding an event changed', () => {
    useAppStore.setState({ processingResult: resultOf('GET /a 200 \t', 'GET /a 200\r') });
    render(<PreviewPanel />);
    expect(unmodifiedCount()).toBe('1 / 1');
  });

  it('checks an event with a long inner run of whitespace quickly', () => {
    // 80k spaces took several seconds with the regex strip.
    const raw = `a${' '.repeat(80_000)}b`;
    useAppStore.setState({ processingResult: resultOf(raw, raw) });
    const start = performance.now();
    render(<PreviewPanel />);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(unmodifiedCount()).toBe('1 / 1');
  });
});

// A selected field that a later run no longer extracts has no checkbox left to
// untick, so it must stop filtering rather than leave "0 / N" behind (#432).
describe('PreviewPanel — the field filter follows the current fields (#432)', () => {
  const meta: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
  function resultWith(fields: Record<string, string[]>): ViewResult {
    return toViewResult({
      events: [{
        _raw: 'user=alice',
        _time: null,
        _meta: {},
        fields,
        metadata: meta,
        lineNumbers: { start: 1, end: 1 },
        processingTrace: [],
      }],
      originalRaw: 'user=alice',
      eventCount: 1,
      processingSteps: [],
      inputMetadata: meta,
    });
  }

  beforeEach(() => {
    useAppStore.setState({ ...initial, activeOutputTab: 'preview', processingResult: resultWith({ user: ['alice'] }) }, true);
  });

  it('drops a selected field that disappears', () => {
    const { container } = render(<PreviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Fields/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'user' }));
    expect(screen.getByText('1 / 1')).toBeInTheDocument();

    act(() => useAppStore.setState({ processingResult: resultWith({ other: ['x'] }) }));
    expect(screen.queryByText(/^\d+ \/ \d+$/)).not.toBeInTheDocument();
    expect(container.textContent).toContain('user=alice');

    // Nor does it come back with the field.
    act(() => useAppStore.setState({ processingResult: resultWith({ user: ['alice'] }) }));
    expect(screen.queryByText(/^\d+ \/ \d+$/)).not.toBeInTheDocument();
  });

  // The Regex tab unmounts on every sub-tab switch, which used to clear what
  // was typed into it (#440).
  it('keeps the Regex tab pattern and class name across tab switches', () => {
    render(<PreviewPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Regex' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Regex Pattern' }), { target: { value: 'user=(?<user>\\w+)' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'EXTRACT class name' }), { target: { value: 'users' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    expect(screen.queryByRole('textbox', { name: 'Regex Pattern' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Fields' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Regex' }));

    expect(screen.getByRole('textbox', { name: 'Regex Pattern' })).toHaveValue('user=(?<user>\\w+)');
    expect(screen.getByRole('textbox', { name: 'EXTRACT class name' })).toHaveValue('users');
  });
});
