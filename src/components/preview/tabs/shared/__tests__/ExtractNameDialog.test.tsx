// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { ExtractNameDialog } from '../ExtractNameDialog';
import { matchInputs } from '../../../../../engine/regexMatch';
import type { RegexMatchRequest, RegexMatchResponse } from '../../../../../engine/regexMatchWorker';

function setup(pattern?: string) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <ExtractNameDialog
      raw="status=200 user=alice"
      selection={pattern ? '' : 'alice'}
      stanza="my:sourcetype"
      onApply={onApply}
      onClose={onClose}
    />,
  );
  return { onApply, onClose };
}

// #34: this dialog used to compile and execute the candidate pattern on the main
// thread on every keystroke, where the pipeline watchdog does not apply. It now
// runs through the same terminatable worker hook the Regex tab uses.
describe('ExtractNameDialog — live capture', () => {
  it('shows the captured group for a matching pattern', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
  });

  it('renders without executing a regex on the render path', () => {
    // A synchronous main-thread exec would have thrown or blocked here; the
    // dialog mounts immediately and resolves the capture asynchronously.
    setup();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// #329: the capture preview did not check that the hook's outcome was for the
// pattern in the box, so for 250 ms after each keystroke "Captures in this
// event" described the previous one; and "Add EXTRACT" was enabled while
// matching was pending, with no compile check — a pattern that had not been
// validated, or was still inside the watchdog window, could be written to
// props.conf. Driven through a fake worker so a request can be held in flight.
describe('ExtractNameDialog — only a settled result for this pattern enables Add (#329)', () => {
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
  const addButton = () => screen.getByRole('button', { name: 'Add EXTRACT' });
  const regexInput = () => screen.getByLabelText('Regex');
  const settle = () => {
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { worker().respond(); });
  };

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps Add disabled until the pattern has been matched', () => {
    const { onApply } = setup();
    expect(addButton()).toBeDisabled();
    expect(screen.getByText('Matching…')).toBeInTheDocument();

    settle();
    expect(screen.getByText('Captures in this event')).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
    fireEvent.click(addButton());
    expect(onApply).toHaveBeenCalledWith('EXTRACT-new_field', expect.stringContaining('(?<new_field>'));
  });

  it("does not show the previous pattern's captures for the one being typed", () => {
    setup();
    settle();
    expect(screen.getByText('alice')).toBeInTheDocument();

    fireEvent.change(regexInput(), { target: { value: 'status=(?<code>\\d+)' } });
    // Inside the debounce window: the old outcome is not this pattern's.
    expect(screen.queryByText('Captures in this event')).not.toBeInTheDocument();
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
    expect(screen.getByText('Matching…')).toBeInTheDocument();
    expect(addButton()).toBeDisabled();

    settle();
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
  });

  it('refuses a pattern that does not compile without sending it to the worker', () => {
    setup();
    settle();
    const posted = worker().posted.length;

    fireEvent.change(regexInput(), { target: { value: '(?<x>unbalanced' } });
    expect(addButton()).toBeDisabled();
    act(() => { vi.advanceTimersByTime(250); });
    expect(addButton()).toBeDisabled();
    // Only the idle request that clears the previous pattern, never this one.
    expect(worker().posted.slice(posted).map((r) => r.pattern)).not.toContain('(?<x>unbalanced');
  });

  it('keeps Add disabled when the pattern times out', () => {
    const { onApply } = setup();
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText(/took too long to run/)).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
    fireEvent.click(addButton());
    expect(onApply).not.toHaveBeenCalled();
  });
});
