// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, within, act } from '@testing-library/react';
import { EffectiveConfigTab } from '../EffectiveConfigTab';
import { usePipelineInputs } from '../shared/usePipelineInputs';
import { useAppStore } from '../../../../store/useAppStore';

/** The tab as PreviewPanel mounts it: fed the inputs of the last pipeline run. */
function Tab() {
  return <EffectiveConfigTab inputs={usePipelineInputs()} />;
}

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

function setConf(propsConf: string) {
  useAppStore.setState(initial, true);
  useAppStore.setState({ propsConf, metadata });
}

describe('EffectiveConfigTab (#86)', () => {
  beforeEach(() => setConf(CONTESTED));

  it('shows the value that actually applies, not the one that lost', () => {
    const { container } = render(<Tab />);
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(within(container).queryByText('= 500')).not.toBeInTheDocument();
  });

  it('names the winning stanza and its line', () => {
    const { container } = render(<Tab />);
    expect(within(container).getByText('[source::/var/log/app.log]:6')).toBeInTheDocument();
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

// #347: the tab read the live editor state, so in manual-apply mode it listed
// config that had not been run, under a footer saying it resolved config the
// way the preview does.
describe('EffectiveConfigTab — follows what the pipeline ran with (#347)', () => {
  beforeEach(() => {
    setConf(CONTESTED);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('in manual-apply mode, keeps the applied config until the pipeline is run', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    const { container } = render(<Tab />);
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(container.textContent).not.toContain('changed since the pipeline last ran');

    act(() => useAppStore.getState().setPropsConf('[my_app]\nTRUNCATE = 123\n'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(within(container).queryByText('= 123')).not.toBeInTheDocument();
    expect(within(container).getByRole('status')).toHaveTextContent('changed since the pipeline last ran');

    act(() => useAppStore.getState().triggerManualRun());
    expect(within(container).getByText('= 123')).toBeInTheDocument();
    expect(within(container).queryByText('= 999')).not.toBeInTheDocument();
    expect(within(container).queryByRole('status')).not.toBeInTheDocument();
  });

  it('in manual-apply mode, keeps the applied metadata until the pipeline is run', () => {
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    const { container } = render(<Tab />);

    // A source that no longer matches [source::…] would hand TRUNCATE back to [my_app].
    act(() => useAppStore.getState().setMetadata({ ...metadata, source: '/elsewhere.log' }));
    expect(within(container).getByText('= 999')).toBeInTheDocument();

    act(() => useAppStore.getState().triggerManualRun());
    expect(within(container).getByText('= 500')).toBeInTheDocument();
  });

  it('in auto mode, follows the editor after the pipeline debounce, with no notice', () => {
    const { container } = render(<Tab />);
    act(() => useAppStore.getState().setPropsConf('[my_app]\nTRUNCATE = 123\n'));
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(within(container).queryByRole('status')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(300); });
    expect(within(container).getByText('= 123')).toBeInTheDocument();
  });
});
