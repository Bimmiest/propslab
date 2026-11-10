import { useCallback, useSyncExternalStore } from 'react';

/** Narrower than Tailwind's `md` breakpoint: the phone layout, one panel at a time. */
export const MOBILE_QUERY = '(max-width: 767px)';

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
      if (typeof window === 'undefined') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', callback);
      return () => mql.removeEventListener('change', callback);
    },
    [query],
  );

  const getSnapshot = useCallback(() => typeof window !== 'undefined' && window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
