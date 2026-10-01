// @vitest-environment jsdom
import type React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render as rtlRender, fireEvent, within, act } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { TransformsTab } from '../TransformsTab';
import { useAppStore } from '../../../../store/useAppStore';
import type { SplunkEvent, ProcessingStep } from '../../../../engine/types';
import { toViewResult, type ViewResult } from '../../../../utils/viewResult';
import { makeEvent } from '../../../../test/makeEvent';

function eventWithTrace(traces: ProcessingStep[]): SplunkEvent {
  return makeEvent('', { processingTrace: traces });
}

function resultOf(events: SplunkEvent[]): ViewResult {
  return toViewResult({
    events,
    originalRaw: '',
    eventCount: events.length,
    processingSteps: [],
    inputMetadata: { index: 'main', host: '', source: '', sourcetype: '' },
  });
}

/** `n` events, each with its own LINE_BREAKER description, as the line breaker writes them. */
function manyEvents(n: number): SplunkEvent[] {
  return Array.from({ length: n }, (_, i) =>
    eventWithTrace([
      {
        processor: 'LINE_BREAKER',
        phase: 'index-time',
        description: `Broke event (lines ${i + 1}-${i + 1})`,
        fieldsAdded: ['f'],
      },
      {
        processor: 'EXTRACT-x',
        phase: 'search-time',
        description: 'Extracted x',
        fieldsAdded: ['x', i % 2 ? 'y' : 'x'],
      },
    ]),
  );
}

const render = (ui: React.ReactElement) => rtlRender(<RadixTooltip.Provider>{ui}</RadixTooltip.Provider>);

const initial = useAppStore.getState();

describe('TransformsTab', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('collapses per-event variants to one summary line and one row per processor', () => {
    useAppStore.setState({ processingResult: resultOf(manyEvents(3)) });
    const { container } = render(<TransformsTab />);
    const view = within(container);
    expect(view.getByText('Broke event')).toBeInTheDocument();
    expect(view.getAllByText('(3/3 events)')).toHaveLength(2);
    expect(view.getByText('Per-event detail (3)')).toBeInTheDocument();
    // Fields are deduplicated, in first-seen order.
    expect(view.getAllByText(/^\+/).map((el) => el.textContent)).toEqual(['+f', '+x', '+y']);
  });

  it('keeps distinct descriptions in first-seen order', () => {
    useAppStore.setState({
      processingResult: resultOf([
        eventWithTrace([{ processor: 'SEDCMD-a', phase: 'index-time', description: 'b' }]),
        eventWithTrace([{ processor: 'SEDCMD-a', phase: 'index-time', description: 'a' }]),
        eventWithTrace([{ processor: 'SEDCMD-a', phase: 'index-time', description: 'b' }]),
      ]),
    });
    const { container } = render(<TransformsTab />);
    const details = container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect([...details.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['b', 'a']);
  });

  // Detail rows render only while open, and the dedup is linear, so 20k events
  // switch in well under a second.
  it('renders no detail rows until opened, then a page at a time', () => {
    useAppStore.setState({ processingResult: resultOf(manyEvents(20_000)) });
    // Asserted by what reaches the DOM rather than by wall-clock time, which
    // would flake on a loaded runner.
    const { container } = render(<TransformsTab />);

    expect(container.querySelectorAll('li')).toHaveLength(0);
    const details = container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(details.querySelectorAll('li')).toHaveLength(100);
    expect(details.querySelector('li')?.textContent).toBe('Broke event (lines 1-1)');

    fireEvent.click(within(details).getByRole('button', { name: /Show 100 more \(19900 not shown\)/ }));
    expect(details.querySelectorAll('li')).toHaveLength(200);

    details.open = false;
    fireEvent(details, new Event('toggle'));
    expect(details.querySelectorAll('li')).toHaveLength(0);
  });

  it('says so when nothing has run', () => {
    const { container } = render(<TransformsTab />);
    expect(within(container).getByText('No transforms applied yet')).toBeInTheDocument();
  });

  // `'var(--color-warning)' + '20'` is not a colour, so the step badges had no
  // background at all (#432).
  it('tints the step badges with a valid colour', () => {
    useAppStore.setState({ processingResult: resultOf(manyEvents(1)) });
    const { container } = render(<TransformsTab />);
    const badge = within(container)
      .getAllByText('1')
      .find((el) => el.className.includes('rounded-full'))!;
    const style = badge.getAttribute('style') ?? '';
    expect(style).toContain('color-mix(in srgb, var(--color-warning) 13%, transparent)');
    expect(style).not.toMatch(/\)[0-9a-f]{2}\b/);
  });

  // A removed field means different things per step: a rewrite of _raw broke
  // its extraction, or FIELDALIAS removed an alias target whose source had no
  // value (#445). The hint must not blame the text for the second.
  it.each([
    ['SEDCMD-mask', 'index-time', /deleted the text "f" is extracted from/],
    ['FIELDALIAS', 'search-time', /source field has no value, so FIELDALIAS … AS removed "f"/],
  ] as const)('explains a field %s removed', (processor, phase, hint) => {
    useAppStore.setState({
      processingResult: resultOf([eventWithTrace([{ processor, phase, description: 'd', fieldsRemoved: ['f'] }])]),
    });
    const { container } = render(<TransformsTab />);
    const chip = within(container).getByText('−f');
    act(() => {
      fireEvent.focus(chip);
    });
    expect(within(document.body).getAllByText(hint).length).toBeGreaterThan(0);
  });
});
