// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// highlightedModules.test.tsx
// The Extractions tab's passes, split out of the component (#511): the badge
// counts.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { eventBadges } from '../eventRows';
import type { FieldCategories } from '../fieldColoring';
import type { EnrichedEvent } from '../../../enrichEvents';
import { makeEvent } from '../../../../../test/makeEvent';

describe('eventBadges', () => {
  const categories: FieldCategories = {
    autoFields: new Set(['kv']),
    manualFields: new Set(['ex', 'both']),
    calcFields: new Set(['both', 'calc']),
    fieldProcessorMap: new Map(),
  };
  const event = makeEvent('x', {
    fields: { kv: '1', ex: '2', both: '3', calc: '4' },
    processingTrace: [
      { processor: 'EVAL', phase: 'search-time', description: '', evalExpressions: { calc: 'x+1', both: 'y' } },
    ],
  });
  const item = {
    event,
    searchText: 'x',
    originalRaw: 'x',
    hasChanges: false,
    hasMetadataChanges: false,
    isDropped: false,
  } as unknown as EnrichedEvent;
  const colors = new Map([
    ['kv', '#1'],
    ['ex', '#2'],
    ['both', '#3'],
    ['calc', '#4'],
  ]);

  it('counts a calculated field once, as calculated, under All', () => {
    expect(eventBadges(item, 'all', colors, categories)).toMatchObject({ autoCount: 1, manualCount: 1, calcCount: 2 });
  });

  it('counts every shown field under its own filter, and calculated fields only under theirs', () => {
    expect(eventBadges(item, 'auto', new Map([['kv', '#1']]), categories)).toMatchObject({
      autoCount: 1,
      manualCount: 0,
      calcCount: 0,
    });
    expect(
      eventBadges(
        item,
        'manual',
        new Map([
          ['ex', '#2'],
          ['both', '#3'],
        ]),
        categories,
      ),
    ).toMatchObject({ autoCount: 0, manualCount: 2, calcCount: 0 });
    expect(eventBadges(item, 'calc', colors, categories)).toMatchObject({ autoCount: 0, manualCount: 0, calcCount: 2 });
  });
});
