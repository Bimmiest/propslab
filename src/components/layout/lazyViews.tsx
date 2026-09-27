import { lazy, Suspense } from 'react';

// Views nobody sees at startup, split out of the entry chunk (#375). Each is
// already mounted on demand, so the only cost is one chunk fetch on first open.
const Dictionary = lazy(() =>
  import('../dictionary/DictionaryView').then((m) => ({ default: m.DictionaryView })),
);
const Scaffold = lazy(() =>
  import('../scaffold/ScaffoldModal').then((m) => ({ default: m.ScaffoldModal })),
);

export function DictionaryView() {
  return (
    <Suspense fallback={null}>
      <Dictionary />
    </Suspense>
  );
}

export function ScaffoldModal() {
  return (
    <Suspense fallback={null}>
      <Scaffold />
    </Suspense>
  );
}
