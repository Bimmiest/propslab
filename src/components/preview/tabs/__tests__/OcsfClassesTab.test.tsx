// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { OcsfClassesTab } from '../OcsfClassesTab';
import { SchemasTab } from '../SchemasTab';
import { useAppStore } from '../../../../store/useAppStore';
import type { ViewResult } from '../../../../utils/viewResult';
import { computeFieldStats } from '../../../../utils/fieldStats';
import { makeEvent } from '../../../../test/makeEvent';

const initial = useAppStore.getState();

/** The run result of one event that has these fields. */
function runWith(fields: Record<string, string>): ViewResult {
  const events = [makeEvent('', { fields })];
  return { events, eventCount: 1, fieldStats: computeFieldStats(events) } as unknown as ViewResult;
}

// Authentication requires `user`, and recommends the other three. User
// Inventory and others also require `user`, and recommend less of these.
const AUTH = { user: 'alice', is_mfa: 'true', logon_type: 'Interactive', 'src_endpoint.ip': '10.0.0.1' };

/** The class cards, by their disclosure buttons, in order. */
const cards = () =>
  screen
    .getAllByRole('button', { expanded: false })
    .filter((b) => b.closest('.border.rounded') && !b.textContent.startsWith('Optional'))
    .map((b) => b.textContent);
const card = (caption: string) =>
  screen.getAllByRole('button').find((b) => b.hasAttribute('aria-expanded') && b.textContent.startsWith(caption))!;

describe('SchemasTab (#892)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    useAppStore.setState({ processingResult: runWith(AUTH) });
  });

  it('shows the CIM view first, and the OCSF view when OCSF is selected', async () => {
    render(<SchemasTab />);
    const group = screen.getByRole('group', { name: 'Schema' });
    expect(within(group).getByRole('button', { name: 'CIM' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/matching models? of 27|27 models/)).toBeInTheDocument();

    fireEvent.click(within(group).getByRole('button', { name: 'OCSF' }));
    expect(within(group).getByRole('button', { name: 'OCSF' })).toHaveAttribute('aria-pressed', 'true');
    expect(useAppStore.getState().schemaView).toBe('ocsf');
    // The OCSF view is a chunk of its own.
    expect(await screen.findByText(/of 57|57 classes/)).toBeInTheDocument();
  });
});

describe('OcsfClassesTab', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    useAppStore.setState({ processingResult: runWith(AUTH) });
  });

  it('says what a match is, and what the view does not check', () => {
    render(<OcsfClassesTab />);
    const header = screen.getByText(/matching class(es)? of 57/);
    expect(header).toHaveTextContent('A match has 50% or more of the required attributes');
    expect(header).toHaveTextContent('OCSF 1.9.0: this view checks that an attribute is present, not its value');
  });

  it('lists the best fit first', () => {
    render(<OcsfClassesTab />);
    expect(cards()[0]).toMatch(/^Authentication/);
  });

  it('shows only the matching classes with the toggle, and filters by text', () => {
    render(<OcsfClassesTab />);
    const all = cards().length;
    const toggle = screen.getByRole('button', { name: 'Show matching only' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const matching = cards();
    expect(matching.length).toBeLessThan(all);
    expect(matching[0]).toMatch(/^Authentication/);

    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter the classes' }), { target: { value: '4001' } });
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatch(/^Network Activity/);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter the classes' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No class matches the filter.')).toBeInTheDocument();
  });

  it('marks a class that a class_uid field declares, and lists it first', () => {
    useAppStore.setState({ processingResult: runWith({ ...AUTH, class_uid: '4001' }) });
    render(<OcsfClassesTab />);
    expect(cards()[0]).toMatch(/^Network Activity/);
    expect(within(card('Network Activity')).getByText('class_uid in the data')).toBeInTheDocument();
  });

  it('opens a class to its attributes, an object to its attributes, and the optional ones on demand', () => {
    render(<OcsfClassesTab />);
    fireEvent.click(card('Authentication'));
    expect(screen.getByText('Required attributes')).toBeInTheDocument();
    expect(screen.getByText('Recommended attributes')).toBeInTheDocument();
    expect(screen.queryByText('Optional attributes', { selector: 'div' })).not.toBeInTheDocument();

    const endpoint = screen.getByRole('button', { name: /^src_endpoint \(1\/\d+\)/ });
    expect(endpoint).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(endpoint);
    expect(endpoint).toHaveAttribute('aria-expanded', 'true');
    const children = document.getElementById(endpoint.getAttribute('aria-controls')!)!;
    expect(within(children).getByText('ip')).toBeInTheDocument();
    expect(within(children).getByText('hostname')).toBeInTheDocument();
    expect(within(children).getByText('network_endpoint', { selector: 'code' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Optional attributes \(\d+ of \d+\)$/ }));
    expect(screen.getByText('Optional attributes', { selector: 'div' })).toBeInTheDocument();
  });

  it('shows the state of a constraint', () => {
    render(<OcsfClassesTab />);
    fireEvent.click(card('Authentication'));
    expect(screen.getByText(/At least one of/)).toHaveTextContent(
      'At least one of dst_endpoint, service: not satisfied',
    );
  });
});
