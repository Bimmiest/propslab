import { describe, it, expect } from 'vitest';
import { createFieldFocusStore } from '../useFieldFocus';

describe('createFieldFocusStore — retainPins', () => {
  it('unpins fields the latest run no longer extracts', () => {
    const store = createFieldFocusStore();
    store.togglePin('user');
    store.togglePin('status');
    store.retainPins(new Set(['status']));
    expect([...store.getPinned()]).toEqual(['status']);
    expect(store.getActive()).toEqual(new Set(['status']));
  });

  it('forgets a hover on a field the latest run no longer extracts (#623)', () => {
    // The hovered span unmounts without a mouseleave, so nothing else clears it.
    const store = createFieldFocusStore();
    let notified = 0;
    store.subscribe(() => notified++);
    store.setHoveredField('user');
    expect(store.getActive()).toEqual(new Set(['user']));

    store.retainPins(new Set(['status']));
    expect(store.getActive()).toBeNull();
    expect(notified).toBe(2);
  });

  it('keeps a hover on a field that is still there, and says nothing when nothing changed', () => {
    const store = createFieldFocusStore();
    store.setHoveredField('user');
    let notified = 0;
    store.subscribe(() => notified++);
    store.retainPins(new Set(['user']));
    expect(store.getActive()).toEqual(new Set(['user']));
    expect(notified).toBe(0);
  });
});
