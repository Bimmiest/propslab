import { useState, type ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { useAppStore } from '../../store/useAppStore';
import { copyToClipboard } from '../../utils/clipboard';

/** Everything the user typed, in one paste-able block. Nothing else holds it: inputs are not persisted. */
function configSnapshot(): string {
  const { rawData, propsConf, transformsConf } = useAppStore.getState();
  return ['# props.conf', propsConf, '', '# transforms.conf', transformsConf, '', '# Raw data', rawData].join('\n');
}

function RootFallback({ error }: { error: Error }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = () => {
    copyToClipboard(configSnapshot()).then(
      () => setCopyState('copied'),
      () => setCopyState('failed'),
    );
  };

  return (
    <div role="alert" className="h-full flex items-center justify-center p-6 bg-[var(--color-bg-primary)]">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">Propslab hit an error</h1>
        <p className="text-sm text-[var(--color-text-secondary)] mb-2">
          {error.message || 'An unexpected error occurred.'}
        </p>
        <p className="text-sm text-[var(--color-text-secondary)] mb-4">
          Your raw data and configuration are not saved anywhere. Copy them before reloading.
        </p>
        <div className="flex justify-center gap-2">
          <button
            onClick={copy}
            className="px-4 py-2 text-sm font-medium rounded-md bg-[var(--color-accent)] text-[var(--color-text-on-accent)] hover:opacity-90 transition-opacity"
          >
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy config'}
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 text-sm font-medium rounded-md border border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The last line of defence, above every panel boundary. A reset here would
 * rarely help (whatever threw at the root will throw again), so it offers the
 * two things that do: keep the user's work, and reload onto the current build.
 */
export function RootErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary panelName="App" fallback={(error) => <RootFallback error={error} />}>
      {children}
    </ErrorBoundary>
  );
}
