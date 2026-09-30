// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TimePrefixDialog } from '../TimePrefixDialog';
import { matchInputs } from '../../../../../engine/regexMatch';
import type { RegexMatchRequest, RegexMatchResponse } from '../../../../../engine/regexMatchWorker';
import { lastRequest, requestsIn } from '../../../../../test/workerInputs';

// TIME_PREFIX is a user regex like EXTRACT's, so "Set TIME_PREFIX" gets the
// same gate: a pattern that does not compile, or has not yet cleared the
// worker's watchdog, cannot be written to props.conf.
describe('TimePrefixDialog — only a settled result for this pattern enables Set', () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((e: MessageEvent<RegexMatchResponse>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    posted: unknown[] = [];
    constructor() { FakeWorker.instances.push(this); }
    postMessage(message: unknown) { this.posted.push(message); }
    terminate() {}
    ready() { this.onmessage?.({ data: { type: 'ready' } } as unknown as MessageEvent<RegexMatchResponse>); }
    respond() {
      const { request: req, inputs } = lastRequest<RegexMatchRequest, string[]>(this.posted, (r) => r.inputs);
      this.onmessage?.({ data: { id: req.id, results: matchInputs(req.pattern, inputs) } } as MessageEvent<RegexMatchResponse>);
    }
  }
  const worker = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;
  const setButton = () => screen.getByRole('button', { name: 'Set TIME_PREFIX' });
  const input = () => screen.getByRole('textbox', { name: /TIME_PREFIX/ });
  const settle = () => {
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { worker().respond(); });
  };

  function setup() {
    const onApply = vi.fn();
    render(
      <TimePrefixDialog
        raw="[2024-01-01 10:00:00] GET /"
        selection="2024-01-01 10:00:00"
        selectionStart={1}
        stanza="access"
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    return { onApply };
  }

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps Set disabled until the pattern has been matched', () => {
    const { onApply } = setup();
    fireEvent.change(input(), { target: { value: '\\[' } });
    expect(setButton()).toBeDisabled();
    expect(screen.getByText('Matching…')).toBeInTheDocument();

    settle();
    expect(screen.getByText(/^Matches/)).toBeInTheDocument();
    expect(setButton()).toBeEnabled();
    fireEvent.click(setButton());
    expect(onApply).toHaveBeenCalledWith('\\[');
  });

  it('refuses a pattern that does not compile without sending it to the worker', () => {
    setup();
    fireEvent.change(input(), { target: { value: '(unbalanced' } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(setButton()).toBeDisabled();
    expect(requestsIn<RegexMatchRequest>(worker().posted).map((r) => r.pattern)).not.toContain('(unbalanced');
  });

  it('keeps Set disabled when the pattern times out', () => {
    const { onApply } = setup();
    fireEvent.change(input(), { target: { value: '\\[' } });
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { worker().ready(); });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText(/took too long to run/)).toBeInTheDocument();
    expect(setButton()).toBeDisabled();
    fireEvent.click(setButton());
    expect(onApply).not.toHaveBeenCalled();
  });
});
