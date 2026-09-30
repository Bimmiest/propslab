// ---------------------------------------------------------------------------
// fieldStats.test.ts
// The field statistics a run carries (#496), which the status bar, the
// preview's field filter, the CIM, Extractions and Fields tabs read instead
// of each walking every event's fields.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { computeFieldStats, fieldCollator, isJsonContainer } from '../fieldStats';
import { toViewResult } from '../viewResult';
import { makeEvent } from '../../test/makeEvent';

const withFields = (fields: Record<string, string | string[]>) => ({ fields });

describe('computeFieldStats', () => {
  it('lists every field once, in first-seen order, with how many events have it', () => {
    const stats = computeFieldStats([
      withFields({ b: '1', a: '2' }),
      withFields({ c: '3', a: '4' }),
      withFields({}),
    ]);
    expect(stats.eventCount).toBe(3);
    expect(stats.names).toEqual(['b', 'a', 'c']);
    expect([...stats.counts]).toEqual([['b', 1], ['a', 2], ['c', 1]]);
  });

  it('marks a field a container when any event holds a whole JSON object or array in it', () => {
    const stats = computeFieldStats([
      withFields({ obj: 'plain', arr: '[1,2]', broken: '{not json}', mv: ['{}', '[]'] }),
      withFields({ obj: ' {"k": 1} ' }),
    ]);
    expect(stats.containers.sort()).toEqual(['arr', 'obj']);
  });

  it('keeps fields named like Object.prototype members as fields', () => {
    const stats = computeFieldStats([withFields(Object.fromEntries([['constructor', 'x'], ['__proto__', 'y']]))]);
    expect(stats.counts.get('constructor')).toBe(1);
    expect(stats.names).toEqual(['constructor', '__proto__']);
  });

  it('is carried on the view result, over the whole run', () => {
    const view = toViewResult({
      events: [makeEvent('a=1', { fields: { a: '1' } }), makeEvent('b={}', { fields: { b: '{}' } })],
      originalRaw: '',
      eventCount: 2,
      processingSteps: [],
      inputMetadata: { index: 'main', host: '', source: '', sourcetype: '' },
    });
    expect(view.fieldStats).toEqual({ eventCount: 2, names: ['a', 'b'], counts: new Map([['a', 1], ['b', 1]]), containers: ['b'] });
    // It crosses the worker boundary by structured clone.
    expect(structuredClone(view.fieldStats)).toEqual(view.fieldStats);
  });
});

describe('isJsonContainer', () => {
  it.each([
    ['{}', true],
    [' [1] ', true],
    ['{"a":', false],
    ['[x]', false],
    ['text', false],
  ])('%j → %s', (value, expected) => {
    expect(isJsonContainer(value)).toBe(expected);
  });

  it('never counts a multivalue', () => {
    expect(isJsonContainer(['{}'])).toBe(false);
  });
});

describe('fieldCollator', () => {
  it('orders as localeCompare does', () => {
    const words = ['b', 'A', 'a', 'B', '_x', '10', '9'];
    expect([...words].sort(fieldCollator.compare)).toEqual([...words].sort((x, y) => x.localeCompare(y)));
  });
});
