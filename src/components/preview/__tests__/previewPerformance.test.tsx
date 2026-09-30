// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// previewPerformance.test.tsx
// The main-thread work the output panel does per run and per keystroke
// (#496): what it re-renders, what it subscribes to, and what it recomputes.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { PreviewPanel, PROCESSING_OVERLAY_DELAY_MS } from '../PreviewPanel';
import type { EnrichedEvent } from '../enrichEvents';
import { EffectiveConfigTab } from '../tabs/EffectiveConfigTab';
import { HighlightedTab } from '../tabs/HighlightedTab';
import { useApplyDirective } from '../tabs/shared/useApplyDirective';
import { ArchitecturePanel } from '../../architecture/ArchitecturePanel';
import { deploymentTiers } from '../../architecture/deploymentTiers';
import { useAppStore } from '../../../store/useAppStore';
import { toViewResult } from '../../../utils/viewResult';
import { makeEvent } from '../../../test/makeEvent';
import type { EventMetadata } from '../../../engine/types';

const initial = useAppStore.getState();
const meta: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

beforeEach(() => {
  useAppStore.setState({ ...initial, metadata: meta }, true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the Processing overlay', () => {
  it('appears only once a run has lasted a moment, and goes the moment it ends', () => {
    vi.useFakeTimers();
    useAppStore.setState({ activeOutputTab: 'effective' });
    render(<PreviewPanel />);
    const overlay = () => screen.queryByText('Processing…');

    act(() => useAppStore.getState().setIsProcessing(true));
    expect(overlay()).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(PROCESSING_OVERLAY_DELAY_MS - 1);
    });
    expect(overlay()).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(overlay()).toBeInTheDocument();

    act(() => useAppStore.getState().setIsProcessing(false));
    expect(overlay()).not.toBeInTheDocument();

    // A run shorter than the delay never shows it.
    act(() => useAppStore.getState().setIsProcessing(true));
    act(() => {
      vi.advanceTimersByTime(20);
    });
    act(() => useAppStore.getState().setIsProcessing(false));
    act(() => {
      vi.advanceTimersByTime(PROCESSING_OVERLAY_DELAY_MS);
    });
    expect(overlay()).not.toBeInTheDocument();
  });
});

describe('subscriptions', () => {
  it('Effective config does not re-render on an edit in auto mode', () => {
    let commits = 0;
    const inputs = { propsConf: '[st]\nTRUNCATE = 5\n', transformsConf: '', metadata: meta };
    render(
      <Profiler
        id="effective"
        onRender={() => {
          commits++;
        }}
      >
        <EffectiveConfigTab inputs={inputs} />
      </Profiler>,
    );
    const before = commits;
    act(() => useAppStore.getState().setPropsConf('[st]\nTRUNCATE = 50\n'));
    act(() => useAppStore.getState().setMetadataField('host', 'other'));
    expect(commits).toBe(before);
  });

  it('Effective config still says so in manual-apply mode', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    const inputs = { propsConf: '[st]\nTRUNCATE = 5\n', transformsConf: '', metadata: meta };
    useAppStore.setState({ propsConf: inputs.propsConf });
    render(<EffectiveConfigTab inputs={inputs} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    act(() => useAppStore.getState().setPropsConf('[st]\nTRUNCATE = 50\n'));
    expect(screen.getByRole('status')).toHaveTextContent('changed since the pipeline last ran');
  });

  it('useApplyDirective re-renders for the sourcetype, not for props.conf, and applies to the latest text', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useApplyDirective();
    });
    const before = renders;
    act(() => useAppStore.getState().setPropsConf('[st]\nA = 1\n'));
    act(() => useAppStore.getState().setPropsConf('[st]\nA = 1\nB = 2\n'));
    expect(renders).toBe(before);

    act(() => result.current.apply('C', '3'));
    expect(useAppStore.getState().propsConf).toContain('B = 2');
    expect(useAppStore.getState().propsConf).toContain('C = 3');

    act(() => useAppStore.getState().setMetadataField('sourcetype', 'other'));
    expect(renders).toBe(before + 1);
    expect(result.current.stanza).toBe('other');
  });
});

describe('Architecture', () => {
  it("reads each directive's phase from the registry", () => {
    expect(deploymentTiers('[st]\nEXTRACT-a = (?<a>x)\n', '')).toEqual({
      hasIndexTime: false,
      hasSearchTime: true,
      hasRouting: false,
    });
    expect(deploymentTiers('[st]\nMAX_DAYS_AGO = 10\n', '')).toEqual({
      hasIndexTime: true,
      hasSearchTime: false,
      hasRouting: false,
    });
    expect(deploymentTiers('[st]\nTRANSFORMS-r = route\n', '')).toEqual({
      hasIndexTime: true,
      hasSearchTime: false,
      hasRouting: true,
    });
    expect(deploymentTiers('[st]\nRULESET-r = route\n', '').hasRouting).toBe(true);
    // Settings that qualify other directives are neither tier.
    expect(deploymentTiers('[st]\nMATCH_LIMIT = 10\n', '')).toEqual({
      hasIndexTime: false,
      hasSearchTime: false,
      hasRouting: false,
    });
  });

  it('counts a transforms.conf rule that writes the queue or metadata as routing', () => {
    expect(deploymentTiers('', '[drop]\nREGEX = .\nDEST_KEY = queue\nFORMAT = nullQueue\n').hasRouting).toBe(true);
    expect(deploymentTiers('', '[idx]\nREGEX = .\nDEST_KEY = _MetaData:Index\nFORMAT = x\n').hasRouting).toBe(true);
    expect(deploymentTiers('', '[f]\nREGEX = (?<a>.)\nFORMAT = a::$1\n').hasRouting).toBe(false);
  });

  it('draws the inputs it is given, not the live editor', () => {
    const inputs = { propsConf: '[st]\nEXTRACT-a = (?<a>x)\n', transformsConf: '', metadata: meta };
    useAppStore.setState({ propsConf: '[st]\nLINE_BREAKER = ([\\r\\n]+)\n' });
    render(<ArchitecturePanel inputs={inputs} embedded />);
    expect(screen.getByText('Search-time field extraction')).toBeInTheDocument();
    expect(screen.queryByText('Index-time processing & storage')).not.toBeInTheDocument();
  });
});

describe("Extractions reads the run's field statistics", () => {
  const trace = [
    { processor: 'EXTRACT-kv', phase: 'search-time' as const, description: '', fieldsAdded: ['user', 'blob'] },
  ];
  const view = toViewResult({
    events: [
      makeEvent('user=alice blob={"k":1}', { fields: { user: 'alice', blob: '{"k":1}' }, processingTrace: trace }),
      makeEvent('user=bob blob=x', { fields: { user: 'bob', blob: 'x' }, processingTrace: trace }),
    ],
    originalRaw: '',
    eventCount: 2,
    processingSteps: [],
    inputMetadata: meta,
  });
  const items: EnrichedEvent[] = view.events.map((event) => ({
    event,
    searchText: event._raw.toLowerCase(),
    originalRaw: event._raw,
    hasChanges: false,
    hasMetadataChanges: false,
    isDropped: false,
  }));

  it('does not parse field values for JSON when the statistics already say', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const { container } = render(
      <HighlightedTab
        items={items}
        allEvents={items}
        currentPage={1}
        eventsPerPage={10}
        fieldStats={view.fieldStats}
      />,
    );
    expect(parse.mock.calls.map(([text]) => text)).not.toContain('{"k":1}');
    // `blob` is a container in the first event, so it is listed but not highlighted anywhere.
    expect(within(container).queryAllByTitle(/^blob \(manual\)/)).toHaveLength(0);
    expect(within(container).getAllByTitle(/^user \(manual\)/)).toHaveLength(2);
  });

  it('lists only the fields of the events a filter leaves', () => {
    const only = [items[1]!];
    const { container } = render(
      <HighlightedTab items={only} allEvents={only} currentPage={1} eventsPerPage={10} fieldStats={view.fieldStats} />,
    );
    expect(within(container).getAllByTitle(/^user \(manual\)/)).toHaveLength(1);
    // Still not highlighted: the run's statistics say it holds JSON.
    expect(within(container).queryAllByTitle(/^blob \(manual\)/)).toHaveLength(0);
  });
});
