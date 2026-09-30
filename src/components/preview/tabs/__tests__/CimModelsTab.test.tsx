// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CimModelsTab } from '../CimModelsTab';
import { useAppStore } from '../../../../store/useAppStore';
import type { ViewResult } from '../../../../utils/viewResult';

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

describe('CimModelsTab "Show matching only" (#495)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    useAppStore.setState({
      processingResult: { events: [{ fields: { src: '10.0.0.1', dest: '10.0.0.2' } }], eventCount: 1 } as unknown as ViewResult,
    });
  });

  it('is a toggle button: one name, its state in aria-pressed', () => {
    render(<CimModelsTab />);
    const before = document.querySelectorAll('[aria-expanded]').length;
    const toggle = screen.getByRole('button', { name: 'Show matching only' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show matching only' })).toHaveAttribute('aria-pressed', 'true');
    // Filtering to the matching models leaves fewer cards.
    expect(document.querySelectorAll('[aria-expanded]').length).toBeLessThan(before);
  });
});
