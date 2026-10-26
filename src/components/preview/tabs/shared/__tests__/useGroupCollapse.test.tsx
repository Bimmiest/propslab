// @vitest-environment jsdom
// The collapse state of the Extractions tab's field groups and the Fields
// tab's parents (#566).

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGroupCollapse } from '../useGroupCollapse';

describe('useGroupCollapse', () => {
  it('starts with every group collapsed, and keeps the set until the groups change', () => {
    const groups = ['a', 'b'];
    const { result, rerender } = renderHook(({ g }) => useGroupCollapse(g), { initialProps: { g: groups } });
    const first = result.current.collapsed;
    expect([...first]).toEqual(['a', 'b']);
    rerender({ g: groups });
    expect(result.current.collapsed).toBe(first);
  });

  it('collapses a group that appears after one was expanded, like every other', () => {
    const { result, rerender } = renderHook(({ groups }) => useGroupCollapse(groups), {
      initialProps: { groups: ['a', 'b'] },
    });
    act(() => result.current.toggleGroup('a'));
    expect([...result.current.collapsed]).toEqual(['b']);
    rerender({ groups: ['a', 'b', 'c'] });
    expect([...result.current.collapsed]).toEqual(['b', 'c']);
    act(() => result.current.toggleGroup('a'));
    expect([...result.current.collapsed]).toEqual(['a', 'b', 'c']);
  });

  it('expands and collapses all at once', () => {
    const { result } = renderHook(() => useGroupCollapse(['a', 'b']));
    act(() => result.current.setAllCollapsed(false));
    expect(result.current.collapsed.size).toBe(0);
    act(() => result.current.setAllCollapsed(true));
    expect([...result.current.collapsed]).toEqual(['a', 'b']);
  });
});
