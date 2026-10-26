// ---------------------------------------------------------------------------
// groupNoOps.test.ts
// One row per directive, with the number of events it missed (#772).
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { groupNoOps } from '../groupNoOps';
import type { DirectiveNoOp, SplunkEvent } from '../types';
import { makeEvent } from '../../test/makeEvent';

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

  it('counts an event once when a directive records two no-ops on it', () => {
    const groups = groupNoOps([event([noMatch, notExplained]), event([])]);
    expect(groups[0]?.eventsAffected).toBe(1);
  });

  it('counts the first event to miss when an earlier one fired', () => {
    expect(groupNoOps([event([]), event([noMatch])])[0]?.eventsAffected).toBe(1);
  });

  it('reads an event with no no-op list as one with none', () => {
    expect(groupNoOps([makeEvent('raw')])).toEqual([]);
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
