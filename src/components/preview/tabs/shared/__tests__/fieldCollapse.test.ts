import { describe, it, expect } from 'vitest';
import { buildParentIndex, isFieldVisible } from '../fieldCollapse';
import type { CollapsibleField } from '../fieldCollapse';

const fields: CollapsibleField[] = [
  { name: 'event', depth: 0, parentName: null },
  { name: 'event.user', depth: 1, parentName: 'event' },
  { name: 'event.user.name', depth: 2, parentName: 'event.user' },
  { name: 'status', depth: 0, parentName: null },
];
const index = buildParentIndex(fields);
const byName = (name: string) => fields.find((f) => f.name === name)!;

describe('isFieldVisible (#15)', () => {
  it('always shows a top-level field', () => {
    expect(isFieldVisible(byName('status'), new Set(['event']), index)).toBe(true);
  });

  it('hides a direct child of a collapsed parent', () => {
    expect(isFieldVisible(byName('event.user'), new Set(['event']), index)).toBe(false);
  });

  it('hides a grandchild when the ROOT is collapsed', () => {
    expect(isFieldVisible(byName('event.user.name'), new Set(['event']), index)).toBe(false);
  });

  it('hides a grandchild when the intermediate is collapsed', () => {
    expect(isFieldVisible(byName('event.user.name'), new Set(['event.user']), index)).toBe(false);
  });

  it('shows a nested field when nothing is collapsed', () => {
    expect(isFieldVisible(byName('event.user.name'), new Set(), index)).toBe(true);
  });

  it('terminates on a cyclic index rather than spinning', () => {
    const cyclic = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    const field: CollapsibleField = { name: 'a', depth: 1, parentName: 'b' };
    expect(isFieldVisible(field, new Set(), cyclic)).toBe(true);
  });
});
