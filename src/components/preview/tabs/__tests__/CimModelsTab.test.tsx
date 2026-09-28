// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CimModelsTab } from '../CimModelsTab';
import { useAppStore } from '../../../../store/useAppStore';

const initial = useAppStore.getState();

describe('CimModelsTab', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it("reports each model card's disclosure state", () => {
    render(<CimModelsTab />);
    const [toggle] = screen.getAllByRole('button', { expanded: false }) as [HTMLElement];
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Recommended Fields')).toBeInTheDocument();
  });
});
