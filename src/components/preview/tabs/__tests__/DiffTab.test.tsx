// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffTab } from '../DiffTab';
import { makeEvent } from '../../../../test/makeEvent';
import type { EnrichedEvent } from '../../enrichEvents';

const enriched = (raw: string, hasChanges: boolean, originalRaw = raw): EnrichedEvent => ({
  event: makeEvent(raw),
  searchText: raw.toLowerCase(),
  originalRaw,
  hasChanges,
  hasMetadataChanges: false,
  isDropped: false,
});

describe('DiffTab', () => {
  it('says why nothing changed when no event was rewritten', () => {
    render(<DiffTab items={[enriched('a', false), enriched('b', false)]} currentPage={1} eventsPerPage={10} />);
    expect(screen.getByRole('status').textContent).toBe(
      'No index-time directive rewrote _raw (SEDCMD, or TRANSFORMS with DEST_KEY = _raw).',
    );
    expect(screen.getAllByText('Unchanged')).toHaveLength(2);
  });

  it('gives no such note when an event changed', () => {
    render(<DiffTab items={[enriched('a', false), enriched('B', true, 'b')]} currentPage={1} eventsPerPage={10} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Modified')).toBeInTheDocument();
  });

  it('gives no note for an empty page', () => {
    render(<DiffTab items={[]} currentPage={1} eventsPerPage={10} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
