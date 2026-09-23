// @vitest-environment jsdom
// A run that failed outright used to fall through to the first-run "No data
// yet" invitation (#294); it has to say that the run failed, and why.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewPanel } from '../PreviewPanel';
import { useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();

describe('PreviewPanel', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initial, activeOutputTab: 'preview' }, true);
  });

  it('invites input before anything has run', () => {
    render(<PreviewPanel />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('shows the failure, not the empty state, when a run produced no result', () => {
    useAppStore.setState({
      processingResult: null,
      validationDiagnostics: [{ level: 'error', message: 'Pipeline timed out after 5 s', file: 'props.conf' }],
    });
    render(<PreviewPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('Pipeline timed out after 5 s');
    expect(screen.queryByText('No data yet')).not.toBeInTheDocument();
  });

  it('ignores warnings when there is no result', () => {
    useAppStore.setState({
      processingResult: null,
      validationDiagnostics: [{ level: 'warning', message: 'unused stanza', file: 'props.conf' }],
    });
    render(<PreviewPanel />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });
});
