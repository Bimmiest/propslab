// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
