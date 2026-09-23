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

  it('wires the active tab and its panel to each other by per-instance ids', () => {
    // #300: ids were the global `tab-${id}`; two tablists (or two mounts of
    // one) could collide and point aria-controls at the wrong panel.
    render(<><PreviewPanel /><PreviewPanel /></>);
    const tabs = screen.getAllByRole('tab', { name: 'Preview' });
    const panels = screen.getAllByRole('tabpanel');
    expect(tabs[0]!.id).not.toBe(tabs[1]!.id);
    tabs.forEach((tab, i) => {
      expect(tab).toHaveAttribute('aria-controls', panels[i]!.id);
      expect(panels[i]).toHaveAttribute('aria-labelledby', tab.id);
    });
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
