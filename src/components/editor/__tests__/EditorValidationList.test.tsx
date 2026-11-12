// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { EditorValidationList } from '../EditorValidationList';
import { useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();

describe('EditorValidationList', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('reports the disclosure state of its summary button', () => {
    useAppStore.setState({
      validationDiagnostics: [{ level: 'error', message: 'Unknown directive', file: 'props.conf' }],
    });
    render(<EditorValidationList file="props.conf" />);
    const toggle = screen.getByRole('button', { name: /1 error/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists the problems the editor marks: the linter and the run, each once (#899)', () => {
    useAppStore.setState({
      propsConf: '[st]\nTIME_FROMAT = %Y\ngarbage\nLOOKUP-x = foo a OUTPUT b\n',
      validationDiagnostics: [
        // Found by the linter too, on the same line: listed once.
        { level: 'error', message: 'Malformed line: "garbage"', file: 'props.conf', line: 3 },
        { level: 'warning', message: 'LOOKUP-x is not simulated', file: 'props.conf', line: 4 },
      ],
    });
    render(<EditorValidationList file="props.conf" />);
    expect(screen.getByRole('button', { name: /1 error\s*2 warnings/ })).toBeInTheDocument();
    const rows = within(screen.getByRole('region', { name: 'props.conf problems' })).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Did you mean "TIME_FORMAT"\?line 2$/),
      expect.stringMatching(/^Malformed line — .*line 3$/),
      'LOOKUP-x is not simulatedline 4',
    ]);
  });

  it('reads the editor text again once it has settled', () => {
    vi.useFakeTimers();
    try {
      useAppStore.setState({ propsConf: '[st]\nKV_MODE = auto\n' });
      render(<EditorValidationList file="props.conf" />);
      expect(screen.getByText('No issues')).toBeInTheDocument();
      act(() => useAppStore.getState().setPropsConf('[st]\ngarbage\n'));
      expect(screen.getByText('No issues')).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(500));
      expect(screen.getByRole('button', { name: /1 error/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
