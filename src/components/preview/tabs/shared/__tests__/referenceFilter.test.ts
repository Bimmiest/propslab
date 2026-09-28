import { describe, it, expect } from 'vitest';
import { filterReference } from '../referenceFilter';

const categories = [
  { name: 'Digits', directives: [{ p: '\\d', d: 'Digit' }, { p: '\\w', d: 'Word character' }] },
  { name: 'Anchors', directives: [{ p: '^', d: 'Start of string' }] },
];
const text = (r: { p: string; d: string }) => [r.p, r.d];

describe('filterReference', () => {
  it('returns the categories unchanged for an empty query', () => {
    expect(filterReference(categories, '', text)).toBe(categories);
  });

  it('keeps only matching rows, case-insensitively, on any of their texts', () => {
    expect(filterReference(categories, 'WORD', text)).toEqual([
      { name: 'Digits', directives: [{ p: '\\w', d: 'Word character' }] },
    ]);
    expect(filterReference(categories, '^', text)).toEqual([
      { name: 'Anchors', directives: [{ p: '^', d: 'Start of string' }] },
    ]);
  });

  it('drops categories left empty', () => {
    expect(filterReference(categories, 'nothing matches this', text)).toEqual([]);
  });
});
