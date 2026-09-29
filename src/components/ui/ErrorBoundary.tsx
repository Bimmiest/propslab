import { Component, type ErrorInfo, type ReactNode } from 'react';
import { noteBoundaryReset } from './retryableLazy';

interface Props {
  children: ReactNode;
  /** A node, or a render function given the error and a reset callback. */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  panelName?: string;
  /**
   * `inline` is a one-line alert for boundaries around chrome (the header,
   * overlays), where the full-height panel fallback would push the app aside.
   */
  variant?: 'panel' | 'inline';
  /** Offers a Close button that clears the error and calls this, e.g. to shut a broken overlay. */
  onDismiss?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[${this.props.panelName ?? 'Unknown'}] Error caught by boundary:`, error, errorInfo);
  }

  handleReset = () => {
    // Before the re-render, so a lazy chunk that failed below retries its import.
    noteBoundaryReset();
    this.setState({ hasError: false, error: null });
  };

  handleDismiss = () => {
    // Batched with the reset, so the closed overlay never re-renders; reopening
    // it later still retries a chunk that failed.
    this.props.onDismiss?.();
    this.handleReset();
  };

  override render() {
    if (this.state.hasError) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback(this.state.error ?? new Error('An unexpected error occurred.'), this.handleReset);
      }
      if (fallback) {
        return fallback;
      }

      if (this.props.variant === 'inline') {
        return (
          <div
            role="alert"
            className="flex items-center gap-3 px-3 py-1.5 text-xs border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)]"
          >
            <span className="flex-1 min-w-0 truncate">
              {this.props.panelName ? `${this.props.panelName} Error` : 'Something went wrong'}
              {this.state.error?.message ? `: ${this.state.error.message}` : ''}
            </span>
            <button
              onClick={this.handleReset}
              className="px-2 py-0.5 font-medium rounded bg-[var(--color-accent)] text-[var(--color-text-on-accent)] hover:opacity-90"
            >
              Try Again
            </button>
            {this.props.onDismiss && (
              <button
                onClick={this.handleDismiss}
                className="px-2 py-0.5 rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
              >
                Close
              </button>
            )}
          </div>
        );
      }

      return (
        <div className="flex flex-col items-center justify-center h-full p-6 bg-[var(--color-bg-primary)]">
          <div className="max-w-md text-center">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
              {this.props.panelName ? `${this.props.panelName} Error` : 'Something went wrong'}
            </h3>
            <p className="text-sm text-[var(--color-text-secondary)] mb-4">
              {this.state.error?.message ?? 'An unexpected error occurred.'}
            </p>
            <button
              onClick={this.handleReset}
              className="px-4 py-2 text-sm font-medium rounded-md bg-[var(--color-accent)] text-[var(--color-text-on-accent)] hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
