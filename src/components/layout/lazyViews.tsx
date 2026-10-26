import { Suspense } from 'react';
import { retryableLazy } from '../ui/retryableLazy';

// Views nobody sees at startup, split out of the entry chunk. Each is
// mounted on first use, so the only cost is one chunk fetch on first open.
// Retryable, since that fetch can fail in a tab left open across a redeploy.
const Dictionary = retryableLazy(() =>
  import('../dictionary/DictionaryView').then((m) => ({ default: m.DictionaryView })),
);
const Scaffold = retryableLazy(() => import('../scaffold/ScaffoldModal').then((m) => ({ default: m.ScaffoldModal })));

export function DictionaryView() {
  return (
    <Suspense fallback={null}>
      <Dictionary />
    </Suspense>
  );
}

export function ScaffoldModal({ open }: { open: boolean }) {
  return (
    <Suspense fallback={null}>
      <Scaffold open={open} />
    </Suspense>
  );
}
