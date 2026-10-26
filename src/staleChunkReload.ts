import { EMPTY_INPUTS, useAppStore } from './store/useAppStore';

// A tab left open across a redeploy asks for hashed chunks the deploy deleted,
// and a retry asks for the same dead URL: only a reload reaches the new build.
// Nothing else keeps the inputs, so they ride over the reload in
// sessionStorage, which is per tab and gone when the tab closes (#706).
const KEY = 'propslab:stale-chunk-reload';
// A chunk that fails this soon after such a reload means a broken build, not
// an old tab, so the error boundary shows it rather than reloading in a loop.
const SETTLE_MS = 10_000;

let carriedOver = false;
let reloading = false;

/** Whether the inputs are saved for a reload, so the unload warning has nothing to protect. */
export function reloadingWithInputs(): boolean {
  return reloading;
}

/** Reload onto the current build when a lazy chunk fails to load (Vite's `vite:preloadError`). */
export function installStaleChunkReload(): void {
  window.addEventListener('vite:preloadError', () => {
    // Offline, a reload lands on the browser's error page; the boundary's Try Again serves better.
    if (reloading || !navigator.onLine || (carriedOver && performance.now() < SETTLE_MS)) return;
    const { rawData, propsConf, transformsConf, metadata, activeView } = useAppStore.getState();
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ rawData, propsConf, transformsConf, metadata, activeView }));
    } catch {
      return; // Not saved (a full quota, blocked storage), so keep the page and the inputs in it.
    }
    reloading = true;
    window.location.reload();
  });
}

/** Put back what a stale-chunk reload carried over. Call before the first render. */
export function restoreStaleChunkReload(): void {
  let saved: string | null;
  try {
    saved = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return;
  }
  if (!saved) return;
  carriedOver = true;
  // The build before the reload wrote this, and its shape may differ: take each field only when it fits.
  const text = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  try {
    const o = JSON.parse(saved) as Record<string, unknown>;
    const m = (o['metadata'] ?? {}) as Record<string, unknown>;
    const empty = EMPTY_INPUTS.metadata;
    useAppStore.setState({
      rawData: text(o['rawData'], ''),
      propsConf: text(o['propsConf'], ''),
      transformsConf: text(o['transformsConf'], ''),
      metadata: {
        index: text(m['index'], empty.index),
        host: text(m['host'], empty.host),
        source: text(m['source'], empty.source),
        sourcetype: text(m['sourcetype'], empty.sourcetype),
      },
      activeView: o['activeView'] === 'dictionary' ? 'dictionary' : 'simulator',
    });
  } catch {
    // Not JSON: there is nothing to put back.
  }
}
