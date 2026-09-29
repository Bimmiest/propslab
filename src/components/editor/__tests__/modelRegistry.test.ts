// Models and view states kept across an editor remount (#453).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { acquireModel, saveViewState, takeViewState, resetModelRegistry } from '../modelRegistry';

function fakeModel() {
  let disposed = false;
  return { isDisposed: () => disposed, dispose: () => { disposed = true; } };
}

describe('modelRegistry', () => {
  beforeEach(() => resetModelRegistry());

  it('hands the same model back for the same file', () => {
    const create = vi.fn(fakeModel);
    const first = acquireModel('props.conf', create);
    expect(acquireModel('props.conf', create)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps one model per file', () => {
    expect(acquireModel('props.conf', fakeModel)).not.toBe(acquireModel('transforms.conf', fakeModel));
  });

  it('replaces a model something else disposed', () => {
    const first = acquireModel('raw', fakeModel);
    first.dispose();
    const second = acquireModel('raw', fakeModel);
    expect(second).not.toBe(first);
    expect(second.isDisposed()).toBe(false);
  });

  it('restores a view state once, to the file it was saved for', () => {
    const state = { cursorState: [] };
    saveViewState('props.conf', state);
    expect(takeViewState('transforms.conf')).toBeUndefined();
    expect(takeViewState('props.conf')).toBe(state);
    expect(takeViewState('props.conf')).toBeUndefined();
  });

  it('forgets a view state when the editor had none', () => {
    saveViewState('raw', { cursorState: [] });
    saveViewState('raw', null);
    expect(takeViewState('raw')).toBeUndefined();
  });
});
