// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CimModelsTab } from '../CimModelsTab';
import { useAppStore } from '../../../../store/useAppStore';
import type { ViewResult } from '../../../../utils/viewResult';
import { computeFieldStats } from '../../../../utils/fieldStats';
import { makeEvent } from '../../../../test/makeEvent';

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

/** The run result of one event that has these fields. */
function runWith(fields: Record<string, string>): ViewResult {
  return {
    events: [{ fields }],
    eventCount: 1,
    fieldStats: computeFieldStats([makeEvent('', { fields })]),
  } as unknown as ViewResult;
}

// Network_Traffic requires 13 fields; with these 9 it has 69% of them.
const TRAFFIC = Object.fromEntries(
  ['action', 'bytes', 'bytes_in', 'bytes_out', 'dest', 'dest_port', 'dvc', 'rule', 'src'].map((f) => [f, '1']),
);

describe('CimModelsTab "Show matching only" (#495, #896)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    useAppStore.setState({ processingResult: runWith(TRAFFIC) });
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

  it('counts only the models with half of their required fields, and says so in the header', () => {
    render(<CimModelsTab />);
    // Sharing one field no longer makes a match: 27 models, a few of them match.
    const header = screen.getByText(/matching models? of 27/);
    expect(header).not.toHaveTextContent(/^27 matching/);
    expect(header).toHaveTextContent('A match has 50% or more of its required fields');
    const count = Number(/^(\d+) matching/.exec(header.textContent)?.[1]);

    fireEvent.click(screen.getByRole('button', { name: 'Show matching only' }));
    expect(document.querySelectorAll('[aria-expanded]')).toHaveLength(count);
  });

  it('lists a model by its required fields before its total', () => {
    render(<CimModelsTab />);
    const cards = [...document.querySelectorAll('[aria-expanded]')].map((c) => c.textContent);
    // No model has a higher required share than the one above it, where it declares required fields.
    const declared = cards.flatMap((text) => {
      const share = /Required(\d+)%/.exec(text)?.[1];
      return share === undefined ? [] : [Number(share)];
    });
    expect(declared).toEqual([...declared].sort((x, y) => y - x));
    const at = (name: string) => cards.findIndex((c) => c.startsWith(name));
    expect(at('Network Traffic')).toBeLessThan(at('Authentication'));
  });
});

describe('CimModelsTab with no matching model (#896)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    useAppStore.setState({ processingResult: runWith({ nothing_cim_knows: '1' }) });
  });

  it('says that none matches, has no toggle, and still lists the models', () => {
    render(<CimModelsTab />);
    expect(screen.getByText(/27 models, none matches yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show matching only' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('[aria-expanded]')).toHaveLength(27);
  });
});
