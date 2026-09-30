// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { StatusBar } from '../StatusBar';
import { useAppStore } from '../../../store/useAppStore';
import type { ValidationDiagnostic, SplunkEvent } from '../../../engine/types';
import { toViewResult, type ViewResult } from '../../../utils/viewResult';
import { EMPTY_FIELD_STATS } from '../../../utils/fieldStats';

function makeEvent(fields: Record<string, string>): SplunkEvent {
  return {
    _raw: '',
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

function renderStatusBar() {
  return render(
    <RadixTooltip.Provider>
      <StatusBar />
    </RadixTooltip.Provider>,
  );
}

const initial = useAppStore.getState();

describe('StatusBar', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('shows "Ready" when no processing has occurred', () => {
    renderStatusBar();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('shows "Worker idle" after a worker run', () => {
    useAppStore.setState({ processingResult: { events: [], eventCount: 0, fieldStats: EMPTY_FIELD_STATS } as unknown as ViewResult });
    renderStatusBar();
    expect(screen.getByText('Worker idle')).toBeInTheDocument();
    expect(screen.queryByTestId('pipeline-main-thread')).toBeNull();
  });

  it('says the pipeline runs on the main thread, not "Worker idle", after a worker load failure (#403)', () => {
    useAppStore.setState({
      processingResult: { events: [], eventCount: 0, fieldStats: EMPTY_FIELD_STATS } as unknown as ViewResult,
      pipelineOnMainThread: true,
    });
    renderStatusBar();
    const state = screen.getByTestId('pipeline-main-thread');
    expect(state).toHaveTextContent('Main thread (no watchdog)');
    expect(screen.queryByText('Worker idle')).toBeNull();
    // Focusable, and its explanation is in the accessible text, not only the tooltip.
    expect(state).toHaveAttribute('tabindex', '0');
    expect(state).toHaveTextContent(/runaway regex freezes the tab/);
  });

  it('shows main-thread processing while an inline run is in progress', () => {
    useAppStore.setState({ isProcessing: true, pipelineOnMainThread: true });
    renderStatusBar();
    expect(screen.getByTestId('pipeline-main-thread')).toHaveTextContent('Processing on main thread…');
  });

  it('shows processing state while worker is running', () => {
    useAppStore.setState({ isProcessing: true });
    renderStatusBar();
    expect(screen.getByText('Processing…')).toBeInTheDocument();
  });

  it('shows event count, distinct field count, and "Valid" when result has no diagnostics', () => {
    const result = toViewResult({
      events: [makeEvent({ a: '1', b: '2' }), makeEvent({ a: '3', c: '4' })],
      originalRaw: '',
      eventCount: 2,
      processingSteps: [],
      inputMetadata: { index: 'main', host: '', source: '', sourcetype: '' },
    });
    useAppStore.setState({ processingResult: result, validationDiagnostics: [] });
    renderStatusBar();
    expect(screen.getByText('2 events')).toBeInTheDocument();
    // distinct fields across events: a, b, c = 3
    expect(screen.getByText('3 fields')).toBeInTheDocument();
    expect(screen.getByText('✓ Valid')).toBeInTheDocument();
  });

  it('shows error / warning counts when diagnostics are present', () => {
    const diags: ValidationDiagnostic[] = [
      { level: 'error', message: 'e1', file: 'props.conf' },
      { level: 'error', message: 'e2', file: 'props.conf' },
      { level: 'warning', message: 'w1', file: 'props.conf' },
    ];
    useAppStore.setState({
      processingResult: toViewResult({ events: [], originalRaw: '', eventCount: 0, processingSteps: [], inputMetadata: { index: 'main', host: '', source: '', sourcetype: '' } }),
      validationDiagnostics: diags,
    });
    renderStatusBar();
    expect(screen.getByText('2 errors')).toBeInTheDocument();
    expect(screen.getByText('1 warning')).toBeInTheDocument();
    expect(screen.queryByText('✓ Valid')).not.toBeInTheDocument();
  });

  it('shows per-event-pipeline chip when setting enabled; click opens settings', () => {
    useAppStore.setState({
      settings: { perEventPipeline: true, manualApply: true },
    });
    renderStatusBar();
    const chip = screen.getByRole('button', { name: /per-event pipeline/i });
    expect(chip).toBeInTheDocument();
    expect(useAppStore.getState().settingsOpen).toBe(false);
    fireEvent.click(chip);
    expect(useAppStore.getState().settingsOpen).toBe(true);
  });

  it('hides per-event-pipeline chip when setting disabled', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: false } });
    renderStatusBar();
    expect(screen.queryByRole('button', { name: /per-event pipeline/i })).not.toBeInTheDocument();
  });

  it('renders timing label in ms under 1s and seconds above', () => {
    useAppStore.setState({ lastProcessingMs: 250, isProcessing: false });
    const { unmount } = renderStatusBar();
    expect(screen.getByText('250ms')).toBeInTheDocument();
    unmount();

    useAppStore.setState({ lastProcessingMs: 1500, isProcessing: false });
    renderStatusBar();
    expect(screen.getByText('1.5s')).toBeInTheDocument();
  });
});
