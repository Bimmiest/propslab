import { describe, it, expect } from 'vitest';
import {
  aggregateFields, buildAliasMap, buildFieldRows, buildRowIds, controlledRowIds, countChildren, fieldComparator,
  findParentFields, immediateParent, nestFields, renderedRowIds, type AggregatedField,
} from '../fieldRows';
import type { ProcessingStep, SplunkEvent } from '../../../../../engine/types';

function makeEvent(fields: SplunkEvent['fields'], processingTrace: ProcessingStep[] = []): SplunkEvent {
  return {
    _raw: '',
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace,
  };
}

function field(name: string, over: Partial<AggregatedField> = {}): AggregatedField {
  return { name, values: new Set(), count: 0, sources: new Set(), phases: new Set(), aliases: [], maskedBy: new Set(), ...over };
}

describe('aggregateFields', () => {
  const events = [
    makeEvent({ a: '1', b: ['x', 'y'], al: '1' }, [
      { processor: 'EXTRACT-a', phase: 'search-time', description: '', fieldsAdded: ['a', 'not_on_event'] },
      { processor: 'INDEXED_EXTRACTIONS', phase: 'index-time', description: '', fieldsAdded: ['b'] },
      { processor: 'SEDCMD-mask', phase: 'index-time', description: '', fieldsModified: ['a'] },
      { processor: 'FIELDALIAS-x', phase: 'search-time', description: '', fieldsAdded: ['al'], fieldAliases: [{ source: 'a', target: 'al' }] },
    ]),
    makeEvent({ a: '1', b: 'z' }, [{ processor: 'EXTRACT-b', phase: 'search-time', description: '', fieldsAdded: ['b'] }]),
  ];
  const byName = new Map(aggregateFields(events, buildAliasMap(events)).map((f) => [f.name, f]));

  it('counts the events that have each field and collects its distinct values, multivalues spread', () => {
    expect(byName.get('a')).toMatchObject({ count: 2, values: new Set(['1']) });
    expect(byName.get('b')).toMatchObject({ count: 2, values: new Set(['x', 'y', 'z']) });
  });

  it('records which steps added a field, and in which phases, only for events that have it', () => {
    expect(byName.get('b')).toMatchObject({
      sources: new Set(['INDEXED_EXTRACTIONS', 'EXTRACT-b']),
      phases: new Set(['index-time', 'search-time']),
    });
    expect(byName.has('not_on_event')).toBe(false);
  });

  it('marks a field an index-time rewrite changed as masked by that step', () => {
    expect(byName.get('a')!.maskedBy).toEqual(new Set(['SEDCMD-mask']));
    expect(byName.get('b')!.maskedBy.size).toBe(0);
  });

  it('folds an alias into its source field rather than giving it a row', () => {
    expect(buildAliasMap(events)).toEqual(new Map([['al', 'a']]));
    expect(byName.get('a')!.aliases).toEqual(['al']);
    expect(byName.has('al')).toBe(false);
  });
});

describe('fieldComparator', () => {
  const a = field('a', { count: 3, values: new Set(['q', 'r']), sources: new Set(['Z']), aliases: ['x'] });
  const b = field('b', { count: 1, values: new Set(['p']), sources: new Set(['Y']), aliases: [] });
  const order = (key: Parameters<typeof fieldComparator>[0], dir: 'asc' | 'desc') =>
    [b, a].sort(fieldComparator(key, dir)).map((f) => f.name).join('');

  it.each([
    ['name', 'ab'], ['count', 'ba'], ['distinct', 'ba'], ['source', 'ba'], ['aliases', 'ba'], ['values', 'ba'],
  ] as const)('orders by %s, ascending and descending', (key, asc) => {
    expect(order(key, 'asc')).toBe(asc);
    expect(order(key, 'desc')).toBe(Array.from(asc).reverse().join(''));
  });
});

describe('the dotted-name tree', () => {
  const names = new Set(['a', 'a.b', 'a.b.c', 'x.y.z', 'x']);

  it('finds every field that has a descendant', () => {
    expect(findParentFields(names)).toEqual(new Set(['a', 'a.b', 'x']));
  });

  it('finds the nearest existing ancestor, skipping missing intermediates', () => {
    expect(immediateParent('a.b.c', names)).toBe('a.b');
    expect(immediateParent('x.y.z', names)).toBe('x');
    expect(immediateParent('a', names)).toBeNull();
    expect(immediateParent('q.r', names)).toBeNull();
  });

  it('places each child after its parent, sorting only the top level by the chosen key', () => {
    const entries = [field('z', { count: 1 }), field('a.c'), field('a', { count: 5 }), field('a.b'), field('a.b.d')];
    const rows = nestFields(entries, fieldComparator('count', 'desc'));
    expect(rows.map((r) => [r.name, r.depth, r.parentName, r.isParent])).toEqual([
      ['a', 0, null, true],
      ['a.b', 1, 'a', true],
      ['a.b.d', 2, 'a.b', false],
      ['a.c', 1, 'a', false],
      ['z', 0, null, false],
    ]);
    expect(countChildren(rows)).toEqual(new Map([['a', 2], ['a.b', 1]]));
  });
});

describe('buildFieldRows', () => {
  const aggregated = [
    field('host', { phases: new Set(['index-time']) }),
    field('user', { phases: new Set(['search-time']), aliases: ['Account'] }),
  ];
  const names = (search: string, phase: 'all' | 'index-time' | 'search-time') =>
    buildFieldRows(aggregated, search, phase, 'name', 'asc').map((r) => r.name);

  it('filters by name or alias, case-insensitively', () => {
    expect(names('HOS', 'all')).toEqual(['host']);
    expect(names('account', 'all')).toEqual(['user']);
  });

  it('filters by phase', () => {
    expect(names('', 'search-time')).toEqual(['user']);
    expect(names('', 'all')).toEqual(['host', 'user']);
  });
});

describe('buildRowIds', () => {
  it('ids rows by position, and lists each parent\'s child rows', () => {
    const rows = nestFields([field('a'), field('a b.c'), field('a b')], fieldComparator('name', 'asc'));
    const { rowIds, childRowIds } = buildRowIds(rows, 'p');
    expect([...rowIds]).toEqual([['a', 'p-row-0'], ['a b', 'p-row-1'], ['a b.c', 'p-row-2']]);
    expect(childRowIds).toEqual(new Map([['a b', ['p-row-2']]]));
  });
});

describe('the rows a windowed table renders (#454)', () => {
  const rows = nestFields([field('a'), field('a.x'), field('a.y'), field('b')], fieldComparator('name', 'asc'));
  const { rowIds, childRowIds } = buildRowIds(rows, 'p');

  it('collects the ids of the rendered rows, skipping spacers and indices past the end', () => {
    const rendered = renderedRowIds(
      [{ kind: 'row', index: 0 }, { kind: 'spacer', key: 'before', height: 20 }, { kind: 'row', index: 2 }, { kind: 'row', index: 9 }],
      rows,
      rowIds,
    );
    expect(rendered).toEqual(new Set(['p-row-0', 'p-row-2']));
  });

  it('names only the rendered children in aria-controls, and none while collapsed', () => {
    const children = childRowIds.get('a');
    expect(children).toEqual(['p-row-1', 'p-row-2']);
    expect(controlledRowIds(children, false, new Set(['p-row-1', 'p-row-2']))).toBe('p-row-1 p-row-2');
    expect(controlledRowIds(children, false, new Set(['p-row-2']))).toBe('p-row-2');
    expect(controlledRowIds(children, false, new Set())).toBeUndefined();
    expect(controlledRowIds(children, true, new Set(['p-row-1']))).toBeUndefined();
    expect(controlledRowIds(undefined, false, new Set(['p-row-1']))).toBeUndefined();
  });
});
