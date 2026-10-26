// @vitest-environment jsdom
// A tab left open across a redeploy reloads onto the new build when a lazy
// chunk is gone, and keeps its inputs over the reload (#706).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reload = vi.fn();
const originalLocation = window.location;
let listeners: EventListenerOrEventListenerObject[] = [];

/** A fresh page load: new module state, a new store, the listener installed as main.tsx does. */
async function loadPage() {
  vi.resetModules();
  const page = await import('../staleChunkReload');
  const { useAppStore } = await import('../store/useAppStore');
  const add = vi.spyOn(window, 'addEventListener');
  page.installStaleChunkReload();
  for (const [type, listener] of add.mock.calls) if (type === 'vite:preloadError') listeners.push(listener);
  add.mockRestore();
  return { ...page, useAppStore };
}

const chunkFails = () => window.dispatchEvent(new Event('vite:preloadError'));

const inputs = {
  rawData: 'raw line',
  propsConf: '[st]\nA = 1',
  transformsConf: '[t]\nREGEX = x',
  metadata: { index: 'web', host: 'h1', source: '/var/log/a.log', sourcetype: 'st' },
};

describe('staleChunkReload', () => {
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
    // A plain stand-in for Location: its prototype is not wanted, only its fields and a spy.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    Object.defineProperty(window, 'location', { value: { ...originalLocation, reload }, configurable: true });
  });

  afterEach(() => {
    for (const listener of listeners) window.removeEventListener('vite:preloadError', listener);
    listeners = [];
    Object.defineProperty(window, 'location', { value: originalLocation, configurable: true });
    vi.restoreAllMocks();
  });

  it('reloads, and the next page load gets back the inputs and the view', async () => {
    const before = await loadPage();
    before.useAppStore.setState({ ...inputs, activeView: 'dictionary' });
    chunkFails();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(before.reloadingWithInputs()).toBe(true);

    const after = await loadPage();
    after.restoreStaleChunkReload();
    expect(after.useAppStore.getState()).toMatchObject({ ...inputs, activeView: 'dictionary' });
    expect(sessionStorage.length).toBe(0);
  });

  it('does not reload when the inputs cannot be saved', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const page = await loadPage();
    chunkFails();
    expect(reload).not.toHaveBeenCalled();
    expect(page.reloadingWithInputs()).toBe(false);
  });

  it('does not reload offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await loadPage();
    chunkFails();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload again when a chunk fails soon after such a reload: the build is broken', async () => {
    await loadPage();
    chunkFails();
    const after = await loadPage();
    after.restoreStaleChunkReload();
    const now = vi.spyOn(performance, 'now').mockReturnValue(5_000);
    chunkFails();
    expect(reload).toHaveBeenCalledTimes(1);
    // Later, it is another redeploy.
    now.mockReturnValue(11_000);
    chunkFails();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('takes only the fields that fit from what an older build saved', async () => {
    sessionStorage.setItem(
      'propslab:stale-chunk-reload',
      JSON.stringify({ rawData: 'raw', propsConf: 7, metadata: { host: 'h1', index: null }, activeView: 'other' }),
    );
    const page = await loadPage();
    page.restoreStaleChunkReload();
    expect(page.useAppStore.getState()).toMatchObject({
      rawData: 'raw',
      propsConf: '',
      metadata: { index: 'main', host: 'h1', source: '', sourcetype: '' },
      activeView: 'simulator',
    });
  });

  it('restores nothing from a value that is not JSON', async () => {
    sessionStorage.setItem('propslab:stale-chunk-reload', '{');
    const page = await loadPage();
    page.restoreStaleChunkReload();
    expect(page.useAppStore.getState().rawData).toBe('');
    expect(sessionStorage.length).toBe(0);
  });
});
