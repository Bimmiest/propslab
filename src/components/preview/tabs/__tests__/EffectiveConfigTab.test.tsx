// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { EffectiveConfigTab } from '../EffectiveConfigTab';
import { useAppStore } from '../../../../store/useAppStore';

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
    const { container } = render(<EffectiveConfigTab />);
    expect(within(container).getByText('= 999')).toBeInTheDocument();
    expect(within(container).queryByText('= 500')).not.toBeInTheDocument();
  });

  it('names the winning stanza and its line', () => {
    const { container } = render(<EffectiveConfigTab />);
    expect(within(container).getByText('[source::/var/log/app.log]:6')).toBeInTheDocument();
  });

  it('counts the contested directives', () => {
    const { container } = render(<EffectiveConfigTab />);
    // The count is assembled from several JSX expressions, so it lands in
    // separate text nodes — assert on the rendered text rather than one node.
    // Two distinct keys survive: TRUNCATE (defined in both stanzas, one wins)
    // and SHOULD_LINEMERGE.
    expect(container.textContent).toContain('2 effective directives, 1 contested');
  });

  it('reveals the overridden definition on expand', () => {
    const { container } = render(<EffectiveConfigTab />);
    expect(within(container).queryByText('TRUNCATE = 500')).not.toBeInTheDocument();

    fireEvent.click(within(container).getByRole('button', { name: /overrides 1 other/ }));
    expect(within(container).getByText('TRUNCATE = 500')).toBeInTheDocument();
    expect(within(container).getByText('[my_app]:2')).toBeInTheDocument();
  });

  it('filters to the contested rows on request', () => {
    const { container } = render(<EffectiveConfigTab />);
    fireEvent.click(within(container).getByRole('button', { name: 'Show contested only' }));
    expect(within(container).getByText('TRUNCATE')).toBeInTheDocument();
    expect(within(container).queryByText('SHOULD_LINEMERGE')).not.toBeInTheDocument();
  });

  it('offers no filter when nothing is contested', () => {
    setConf('[my_app]\nTRUNCATE = 500\n');
    const { container } = render(<EffectiveConfigTab />);
    expect(within(container).queryByRole('button', { name: 'Show contested only' })).not.toBeInTheDocument();
    expect(within(container).getByText('1 effective directive')).toBeInTheDocument();
  });

  it('explains an empty result rather than rendering a blank panel', () => {
    setConf('[someone_else]\nTRUNCATE = 500\n');
    const { container } = render(<EffectiveConfigTab />);
    expect(within(container).getByText(/No stanza in props.conf matches/)).toBeInTheDocument();
  });

  it('says so when there is no props.conf at all', () => {
    setConf('');
    const { container } = render(<EffectiveConfigTab />);
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
    const { container } = render(<EffectiveConfigTab />);
    expect(within(container).getByText('= 777')).toBeInTheDocument();
    expect(within(container).queryByText('= 500')).not.toBeInTheDocument();
    expect(container.textContent).toContain('Sourcetype assigned at input: my_app → assigned');
  });

  it('says nothing about assignment when there is none', () => {
    const { container } = render(<EffectiveConfigTab />);
    expect(container.textContent).not.toContain('Sourcetype assigned at input');
  });

  it('needs no processed events — it resolves config, not output', () => {
    // processingResult is left null by setConf; the panel still answers.
    const { container } = render(<EffectiveConfigTab />);
    expect(useAppStore.getState().processingResult).toBeNull();
    expect(within(container).getByText('= 999')).toBeInTheDocument();
  });
});
