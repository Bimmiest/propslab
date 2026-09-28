import { lazy, type ComponentType } from 'react';

// Bumped by every ErrorBoundary reset. A module counter rather than a context:
// one lazy component can sit under several boundaries (each editor panel has
// its own), and whichever one the user resets has to trigger the retry.
let resetEpoch = 0;

/** Called by ErrorBoundary when the user asks it to try again. */
export function noteBoundaryReset(): void {
  resetEpoch++;
}

/**
 * React.lazy, but a failed import can be retried.
 *
 * React caches a lazy component's rejected promise forever, so after a chunk
 * fails to load (a flaky network, or a redeploy that removed the old hashed
 * chunks) an ErrorBoundary's "Try Again" would only rethrow the same error.
 * This builds a fresh lazy() once a boundary has been reset since the failure.
 * Keying on the reset, not merely on the failure, matters: React re-renders a
 * throwing component before committing the error, and rebuilding there would
 * refetch a dead chunk in a loop without the user ever seeing the fallback.
 */
export function retryableLazy<T extends ComponentType<never>>(load: () => Promise<{ default: T }>): T {
  interface Entry {
    // Props pass straight through; T's own props type is what callers see.
    Lazy: ComponentType<object>;
    failedAt: number | null;
  }
  const make = (): Entry => {
    const entry: Entry = {
      Lazy: lazy(() => {
        const loading = load();
        void loading.catch(() => {
          entry.failedAt = resetEpoch;
        });
        return loading as unknown as Promise<{ default: ComponentType<object> }>;
      }),
      failedAt: null,
    };
    return entry;
  };
  let entry = make();

  function Retryable(props: object) {
    if (entry.failedAt !== null && resetEpoch > entry.failedAt) entry = make();
    const Lazy = entry.Lazy;
    return <Lazy {...props} />;
  }
  return Retryable as unknown as T;
}
