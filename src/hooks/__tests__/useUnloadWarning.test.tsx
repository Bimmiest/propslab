// @vitest-environment jsdom
// The leave-page prompt is armed only while the session holds edits (#453).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUnloadWarning } from '../useUnloadWarning';
import { useAppStore } from '../../store/useAppStore';

const initial = useAppStore.getState();

function fireBeforeUnload() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe('useUnloadWarning', () => {
  beforeEach(() => useAppStore.setState(initial, true));
  afterEach(() => useAppStore.setState(initial, true));

  it('does not prompt over an untouched session', () => {
    renderHook(() => useUnloadWarning());
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('prompts once an input differs from what was loaded, and stops when it matches again', () => {
    renderHook(() => useUnloadWarning());
    act(() => useAppStore.getState().setPropsConf('[x]\nSHOULD_LINEMERGE = false'));
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
    act(() => useAppStore.getState().setPropsConf(useAppStore.getState().loadedInputs.propsConf));
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('stops prompting once the edited inputs become the loaded baseline', () => {
    renderHook(() => useUnloadWarning());
    act(() => useAppStore.getState().setMetadataField('host', 'web01'));
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
    act(() => {
      const s = useAppStore.getState();
      s.loadInputs({
        rawData: s.rawData,
        propsConf: s.propsConf,
        transformsConf: s.transformsConf,
        metadata: s.metadata,
      });
    });
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useUnloadWarning());
    act(() => useAppStore.getState().setRawData('some log line'));
    unmount();
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });
});
