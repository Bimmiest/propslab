// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { DirectiveNoOpList } from '../DirectiveNoOpList';
import { groupNoOps } from '../../../../../engine/groupNoOps';
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

describe('groupNoOps', () => {
  it('collapses the same directive across events into one row', () => {
    const groups = groupNoOps([event([noMatch]), event([noMatch]), event([noMatch])]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.eventsAffected).toBe(3);
  });

  it('keeps distinct reasons for the same directive, commonest first', () => {
    const other: DirectiveNoOp = { ...noMatch, reason: { kind: 'source-key-empty', sourceKey: '_raw' } };
    const groups = groupNoOps([event([noMatch]), event([other]), event([other])]);
    expect(groups[0]?.reasons).toHaveLength(2);
    expect(groups[0]?.reasons[0]?.events).toBe(2);
    expect(groups[0]?.reasons[0]?.text).toContain('_raw is empty');
  });

  it('keeps two directives on the same line apart', () => {
    const sameLine: DirectiveNoOp = { ...missingStanza, line: 3 };
    expect(groupNoOps([event([noMatch, sameLine])])).toHaveLength(2);
  });

  it('returns nothing for events with no no-ops', () => {
    expect(groupNoOps([event([])])).toEqual([]);
  });

  it('counts events past the explanation limit apart from the reasons (#452)', () => {
    // Fifty analysed misses and 450 past the cap: the headline must stay the
    // real reason, not "not analysed", however many there are of the latter.
    const groups = groupNoOps([event([noMatch]), event([notExplained]), event([notExplained])]);
    expect(groups[0]?.eventsAffected).toBe(3);
    expect(groups[0]?.notExplained).toBe(2);
    expect(groups[0]?.reasons).toEqual([{ text: expect.stringContaining('stopped agreeing') as string, events: 1 }]);
  });
});

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
    expect(container.textContent).toContain('no effect on 2 of 3 events');
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
