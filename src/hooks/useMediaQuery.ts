import { useCallback, useSyncExternalStore } from 'react';

/**
 * Subscribe to a CSS media query and re-render when its match state changes.
 * Returns false during server-side rendering (no `window`).
 */
export function useMediaQuery(query: string): boolean {
  // Memoise subscribe/getSnapshot per `query` — otherwise new function identities
  // each render make useSyncExternalStore tear down and re-add the matchMedia
  // listener on (almost) every render.
  const subscribe = useCallback(
    (callback: () => void) => {
      // jsdom has no matchMedia, whatever the DOM types say.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', callback);
      return () => mql.removeEventListener('change', callback);
    },
    [query],
  );

  const getSnapshot = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- as in subscribe
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches,
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
