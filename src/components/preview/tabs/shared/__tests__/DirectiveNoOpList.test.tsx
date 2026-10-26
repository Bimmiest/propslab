// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { DirectiveNoOpList } from '../DirectiveNoOpList';
import type { DirectiveNoOp, SplunkEvent } from '../../../../../engine/types';
import { makeEvent } from '../../../../../test/makeEvent';

function event(noOps: DirectiveNoOp[]): SplunkEvent {
  return makeEvent('raw', { noOps });
}

const noMatch: DirectiveNoOp = {
  directive: 'EXTRACT-user',
  file: 'props.conf',
  line: 3,
  phase: 'search-time',
  reason: { kind: 'no-match', partialEnd: 10 },
};

const notExplained: DirectiveNoOp = { ...noMatch, reason: { kind: 'not-explained' } };

const missingStanza: DirectiveNoOp = {
  directive: 'TRANSFORMS-mask → [maskit]',
  file: 'props.conf',
  line: 4,
  phase: 'index-time',
  reason: { kind: 'transforms-stanza-missing', name: 'maskit' },
};

describe('DirectiveNoOpList', () => {
  it('renders nothing at all when every directive fired', () => {
    // An empty panel heading would be noise on a working config.
    const { container } = render(<DirectiveNoOpList events={[event([])]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the directive and explains it', () => {
    const { container } = render(<DirectiveNoOpList events={[event([noMatch])]} />);
    expect(within(container).getByText('EXTRACT-user')).toBeInTheDocument();
    expect(within(container).getByText(/stopped agreeing at character 10/)).toBeInTheDocument();
  });

  it('says how many events it had no effect on', () => {
    const { container } = render(<DirectiveNoOpList events={[event([noMatch]), event([noMatch]), event([])]} />);
    fireEvent.click(within(container).getByRole('button', { name: /Fired on some events/ }));
    expect(container.textContent).toContain('no effect on 2 of 3 events');
  });

  // In a sourcetype with several log structures, most directives are written
  // for one structure and miss the others; only one that fired nowhere is a
  // warning (#772).
  it('warns only about a directive that had no effect on any event', () => {
    const { container } = render(<DirectiveNoOpList events={[event([noMatch, missingStanza]), event([noMatch])]} />);
    expect(container.textContent).toContain('Did not fire (1)');
    expect(container.textContent).toContain('EXTRACT-user');
    expect(container.textContent).toContain('Fired on some events (1)');
    expect(container.textContent).not.toContain('maskit');
  });

  it('keeps a directive that fired on some events collapsed, with its reasons behind Why', () => {
    const { container } = render(<DirectiveNoOpList events={[event([noMatch]), event([])]} />);
    expect(container.textContent).not.toContain('Did not fire');
    const heading = within(container).getByRole('button', { name: 'Fired on some events (1)' });
    expect(heading).toHaveAttribute('aria-expanded', 'false');
    expect(container.textContent).not.toContain('EXTRACT-user');

    fireEvent.click(heading);
    expect(container.textContent).toContain('EXTRACT-user');
    expect(container.textContent).not.toContain('stopped agreeing');
    fireEvent.click(within(container).getByRole('button', { name: 'Why' }));
    expect(container.textContent).toContain('stopped agreeing at character 10');
  });

  it('offers a jump to the line it is written on', () => {
    const { container } = render(<DirectiveNoOpList events={[event([noMatch])]} />);
    expect(within(container).getByRole('button', { name: 'props.conf:3' })).toBeInTheDocument();
  });

  it('filters by phase when asked', () => {
    const events = [event([noMatch, missingStanza])];
    const searchTime = render(<DirectiveNoOpList events={events} phase="search-time" />);
    expect(searchTime.container.textContent).toContain('EXTRACT-user');
    expect(searchTime.container.textContent).not.toContain('maskit');

    const indexTime = render(<DirectiveNoOpList events={events} phase="index-time" />);
    expect(indexTime.container.textContent).toContain('maskit');
    expect(indexTime.container.textContent).not.toContain('EXTRACT-user');
  });

  it('says how many events were not analysed, under the real reason', () => {
    const { container } = render(
      <DirectiveNoOpList events={[event([noMatch]), event([notExplained]), event([notExplained])]} />,
    );
    expect(container.textContent).toContain('no effect on 3 of 3 events');
    expect(within(container).getByText(/stopped agreeing at character 10/)).toBeInTheDocument();
    expect(container.textContent).toContain(
      'Not analysed: explanation limit reached for this directive (2 more events)',
    );
    // Not offered as another reason: it is the absence of one.
    expect(within(container).queryByRole('button', { name: /other reason/ })).toBeNull();
  });

  it('falls back to the limit message when no event was analysed', () => {
    const { container } = render(<DirectiveNoOpList events={[event([notExplained])]} />);
    expect(container.textContent).toContain('Not analysed: explanation limit reached for this directive');
    expect(container.textContent).not.toContain('more event');
  });

  it('hides secondary reasons behind a toggle', () => {
    const other: DirectiveNoOp = { ...noMatch, reason: { kind: 'source-key-empty', sourceKey: '_raw' } };
    const { container } = render(<DirectiveNoOpList events={[event([noMatch]), event([other])]} />);

    expect(container.textContent).not.toContain('_raw is empty');
    fireEvent.click(within(container).getByRole('button', { name: /1 other reason/ }));
    expect(container.textContent).toContain('_raw is empty');
  });
});
