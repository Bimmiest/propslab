import { useEffect } from 'react';
import { useAppStore, selectSessionDirty } from '../store/useAppStore';

function warn(e: BeforeUnloadEvent) {
  // preventDefault is what current browsers honour; returnValue is for the
  // ones that still ask for it. Either way the browser shows its own generic
  // prompt, and nothing of the session is written anywhere (#453).
  e.preventDefault();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberately, for those browsers
  e.returnValue = '';
}

/**
 * Ask before a close or reload throws away edits, and only then: a listener
 * that is always registered would also prompt over an untouched example, and
 * keeps the page out of the back/forward cache.
 */
export function useUnloadWarning(): void {
  const dirty = useAppStore(selectSessionDirty);
  useEffect(() => {
    if (!dirty) return;
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
