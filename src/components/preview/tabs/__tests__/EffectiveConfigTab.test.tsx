// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, within, act } from '@testing-library/react';
import { EffectiveConfigTab } from '../EffectiveConfigTab';
import { usePipelineInputs } from '../shared/usePipelineInputs';
import { revealInEditor } from '../../../editor/revealInEditor';
import { useAppStore } from '../../../../store/useAppStore';
import { answerRun } from '../../../../test/answerRun';

/** The tab as PreviewPanel mounts it: fed the inputs of the run on screen. */
function Tab() {
  return <EffectiveConfigTab inputs={usePipelineInputs()} />;
}

vi.mock('../../../editor/revealInEditor', () => ({ revealInEditor: vi.fn() }));

const metadata = {
  index: 'main',
  host: 'web01',
  source: '/var/log/app.log',
  sourcetype: 'my_app',
};

const CONTESTED = [
  '[my_app]',
  'TRUNCATE = 500',
  'SHOULD_LINEMERGE = false',
  '',
  '[source::/var/log/app.log]',
  'TRUNCATE = 999',
].join('\n');

const initial = useAppStore.getState();

/** Config that a run has read: the editors hold it, and the run on screen used it. */
function setConf(propsConf: string) {
  useAppStore.setState(initial, true);
  useAppStore.setState({ propsConf, metadata });
  answerRun();
}

describe('EffectiveConfigTab (#86)', () => {
  beforeEach(() => setConf(CONTESTED));

  it('shows the value that actually applies, not the one that lost', () => {
    const { container } = render(<Tab />);
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(within(container).queryByText('= 500')).not.toBeInTheDocument();
  });

  it('groups the directives under one heading per stanza, with the line on the row', () => {
    const { container } = render(<Tab />);
    const source = within(container).getByRole('region', { name: '[source::/var/log/app.log]' });
    expect(within(source).getByText('source stanza')).toBeInTheDocument();
    expect(within(source).getByText('= 999')).toBeInTheDocument();
    expect(within(source).getByRole('button', { name: 'Jump to line 6 of props.conf' })).toHaveTextContent(':6');

    const sourcetype = within(container).getByRole('region', { name: '[my_app]' });
    expect(within(sourcetype).getByText('sourcetype stanza')).toBeInTheDocument();
    expect(within(sourcetype).getByText('SHOULD_LINEMERGE')).toBeInTheDocument();
    // The stanza is named once, not on each row.
    expect(within(sourcetype).getAllByText('[my_app]')).toHaveLength(1);
  });

  it('does not cut a long value, and wraps it under the key', () => {
    const long = 'x'.repeat(300);
    setConf(`[my_app]\nFIELDALIAS-cim = ${long} AS y\n`);
    const { container } = render(<Tab />);
    const value = within(container).getByText(`= ${long} AS y`);
    expect(value.className).not.toContain('truncate');
    expect(value.parentElement?.className).toContain('-indent-4');
    expect(container.textContent).not.toContain('…');
  });

  it('jumps to the stanza from its heading', () => {
    const { container } = render(<Tab />);
    fireEvent.click(within(container).getByRole('button', { name: '[source::/var/log/app.log]' }));
    expect(revealInEditor).toHaveBeenCalledWith('props.conf', 5);
  });

  it('counts the contested directives', () => {
    const { container } = render(<Tab />);
    // The count is assembled from several JSX expressions, so it lands in
    // separate text nodes — assert on the rendered text rather than one node.
    // Two distinct keys survive: TRUNCATE (defined in both stanzas, one wins)
    // and SHOULD_LINEMERGE.
    expect(container.textContent).toContain('2 effective directives, 1 contested');
  });

  it('reveals the overridden definition on expand', () => {
    const { container } = render(<Tab />);
    expect(within(container).queryByText('TRUNCATE = 500')).not.toBeInTheDocument();

    fireEvent.click(within(container).getByRole('button', { name: /overrides 1 other/ }));
    expect(within(container).getByText('TRUNCATE = 500')).toBeInTheDocument();
    expect(within(container).getByText('[my_app]:2')).toBeInTheDocument();
  });

  it('filters to the contested rows on request', () => {
    const { container } = render(<Tab />);
    fireEvent.click(within(container).getByRole('button', { name: 'Show contested only' }));
    expect(within(container).getByText('TRUNCATE')).toBeInTheDocument();
    expect(within(container).queryByText('SHOULD_LINEMERGE')).not.toBeInTheDocument();
  });

  it('offers no filter when nothing is contested', () => {
    setConf('[my_app]\nTRUNCATE = 500\n');
    const { container } = render(<Tab />);
    expect(within(container).queryByRole('button', { name: 'Show contested only' })).not.toBeInTheDocument();
    expect(within(container).getByText('1 effective directive')).toBeInTheDocument();
  });

  it('explains an empty result rather than rendering a blank panel', () => {
    setConf('[someone_else]\nTRUNCATE = 500\n');
    const { container } = render(<Tab />);
    expect(within(container).getByText(/No stanza in props.conf matches/)).toBeInTheDocument();
  });

  it('says so when there is no props.conf at all', () => {
    setConf('');
    const { container } = render(<Tab />);
    expect(within(container).getByText('No props.conf yet.')).toBeInTheDocument();
  });

  it('resolves an input-time sourcetype assignment, as the preview does (#328)', () => {
    // [source::…] assigns `assigned`; the pipeline then re-matches against it,
    // so [assigned]'s TRUNCATE applies and [my_app]'s never did.
    setConf(
      [
        '[source::/var/log/app.log]',
        'sourcetype = assigned',
        '',
        '[my_app]',
        'TRUNCATE = 500',
        '',
        '[assigned]',
        'TRUNCATE = 777',
      ].join('\n'),
    );
    const { container } = render(<Tab />);
    expect(within(container).getByText('= 777')).toBeInTheDocument();
    expect(within(container).queryByText('= 500')).not.toBeInTheDocument();
    expect(container.textContent).toContain('Sourcetype assigned at input: my_app → assigned');
  });

  it('says nothing about assignment when there is none', () => {
    const { container } = render(<Tab />);
    expect(container.textContent).not.toContain('Sourcetype assigned at input');
  });

  it('needs no processed events — it resolves config, not output', () => {
    // processingResult is left null by setConf; the panel still answers.
    const { container } = render(<Tab />);
    expect(useAppStore.getState().processingResult).toBeNull();
    expect(within(container).getByText('= 999')).toBeInTheDocument();
  });
});

// The tab lists the config of the run on screen, not the live editor state,
// which in manual-apply mode has not been run, and during a run is ahead of
// the events (#879).
describe('EffectiveConfigTab — follows what the pipeline ran with (#347, #879)', () => {
  beforeEach(() => {
    setConf(CONTESTED);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('in manual-apply mode, keeps the config of the run until another run answers', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    const { container } = render(<Tab />);
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(container.textContent).not.toContain('changed since the pipeline last ran');

    act(() => useAppStore.getState().setPropsConf('[my_app]\nTRUNCATE = 123\n'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(within(container).queryByText('= 123')).not.toBeInTheDocument();
    expect(within(container).getByRole('status')).toHaveTextContent('changed since the pipeline last ran');

    // A click on Run alone changes nothing here: the tab follows the answer.
    act(() => useAppStore.getState().triggerManualRun());
    expect(within(container).getByText('= 999')).toBeInTheDocument();

    act(() => answerRun());
    expect(within(container).getByText('= 123')).toBeInTheDocument();
    expect(within(container).queryByText('= 999')).not.toBeInTheDocument();
    expect(within(container).queryByRole('status')).not.toBeInTheDocument();
  });

  it('in manual-apply mode, keeps the metadata of the run until another run answers', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    const { container } = render(<Tab />);

    // A source that no longer matches [source::…] would hand TRUNCATE back to [my_app].
    act(() => useAppStore.getState().setMetadata({ ...metadata, source: '/elsewhere.log' }));
    expect(within(container).getByText('= 999')).toBeInTheDocument();

    act(() => answerRun());
    expect(within(container).getByText('= 500')).toBeInTheDocument();
  });

  it('in manual-apply mode, a tab mounted after unrun edits shows the run, not the edits', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    act(() => useAppStore.getState().setPropsConf('[my_app]\nTRUNCATE = 123\n'));
    const { container } = render(<Tab />);
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(within(container).queryByText('= 123')).not.toBeInTheDocument();
  });

  it('in auto mode, keeps the config of the events on screen while a slow run is in the worker', () => {
    const { container } = render(<Tab />);
    act(() => useAppStore.getState().setPropsConf('[my_app]\nTRUNCATE = 123\n'));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(within(container).queryByRole('status')).not.toBeInTheDocument();

    act(() => answerRun());
    expect(within(container).getByText('= 123')).toBeInTheDocument();
    expect(within(container).queryByRole('status')).not.toBeInTheDocument();
  });
});
