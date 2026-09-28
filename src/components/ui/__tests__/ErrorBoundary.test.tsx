// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// ErrorBoundary.test.tsx
// A failed lazy chunk must be retryable from "Try Again" (React caches the
// rejected import), and the root boundary must hand back the user's inputs,
// which nothing else persists (#423).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { RootErrorBoundary } from '../RootErrorBoundary';
import { retryableLazy } from '../retryableLazy';
import { useAppStore } from '../../../store/useAppStore';

beforeEach(() => {
  // The boundary logs what it catches, and React logs it again.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error('kaboom');
}

describe('retryableLazy', () => {
  it('refetches a chunk that failed once the boundary is reset', async () => {
    const load = vi
      .fn<() => Promise<{ default: () => React.JSX.Element }>>()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue({ default: () => <p>scaffold loaded</p> });
    const Scaffold = retryableLazy(load);

    render(
      <ErrorBoundary panelName="Scaffold" variant="inline">
        <Suspense fallback={null}>
          <Scaffold />
        </Suspense>
      </ErrorBoundary>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch dynamically imported module');
    // React re-renders a throwing component before committing the error; that
    // must not have refetched.
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
      await Promise.resolve();
    });
    expect(await screen.findByText('scaffold loaded')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one successful load between instances', async () => {
    const load = vi.fn(() => Promise.resolve({ default: ({ n }: { n: number }) => <p>view {n}</p> }));
    const View = retryableLazy(load);
    render(
      <Suspense fallback={null}>
        <View n={1} />
        <View n={2} />
      </Suspense>,
    );
    expect(await screen.findByText('view 2')).toBeInTheDocument();
    expect(screen.getByText('view 1')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorBoundary', () => {
  it('offers Close on an inline boundary and reports it', () => {
    const onDismiss = vi.fn();
    render(
      <ErrorBoundary panelName="Scaffold" variant="inline" onDismiss={onDismiss}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Scaffold Error: kaboom');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('RootErrorBoundary', () => {
  it('copies props, transforms and raw data to the clipboard', async () => {
    useAppStore.setState({ rawData: 'raw line', propsConf: '[st]\nA = 1', transformsConf: '[t]\nREGEX = x' });
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(
      <RootErrorBoundary>
        <Boom />
      </RootErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('kaboom');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy config' }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(
      '# props.conf\n[st]\nA = 1\n\n# transforms.conf\n[t]\nREGEX = x\n\n# Raw data\nraw line',
    );
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('reloads the page', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, reload }, configurable: true });
    try {
      render(
        <RootErrorBoundary>
          <Boom />
        </RootErrorBoundary>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });
});
