// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { FieldsTab } from '../FieldsTab';
import { useAppStore } from '../../../../store/useAppStore';
import type { ProcessingResult, SplunkEvent, ProcessingStep } from '../../../../engine/types';

function makeEvent(
  fields: Record<string, string>,
  traces: ProcessingStep[],
): SplunkEvent {
  return {
    _raw: '',
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: traces,
  };
}

// An event with fields from both index-time and search-time phases.
const event = makeEvent(
  { idx_field: 'a', ext_field: 'b', evaled: '1' },
  [
    { processor: 'INDEXED_EXTRACTIONS', phase: 'index-time', description: '', fieldsAdded: ['idx_field'] },
    { processor: 'EXTRACT-foo', phase: 'search-time', description: '', fieldsAdded: ['ext_field'] },
    { processor: 'EVAL', phase: 'search-time', description: '', fieldsAdded: ['evaled'] },
  ],
);

const result: ProcessingResult = {
  events: [event],
  originalRaw: '',
  eventCount: 1,
  processingSteps: [],
  inputMetadata: { index: 'main', host: '', source: '', sourcetype: '' },
};

const initial = useAppStore.getState();

describe('FieldsTab', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    useAppStore.setState({ processingResult: result });
  });

  it('renders all fields when phase filter is "All"', () => {
    const { container } = render(<FieldsTab />);
    expect(within(container).getByText('idx_field')).toBeInTheDocument();
    expect(within(container).getByText('ext_field')).toBeInTheDocument();
    expect(within(container).getByText('evaled')).toBeInTheDocument();
    expect(within(container).getByText('3 fields')).toBeInTheDocument();
  });

  it('filters to index-time only when Index-time pill is clicked', () => {
    const { container } = render(<FieldsTab />);
    fireEvent.click(within(container).getByRole('button', { name: 'Index-time' }));
    expect(within(container).getByText('idx_field')).toBeInTheDocument();
    expect(within(container).queryByText('ext_field')).not.toBeInTheDocument();
    expect(within(container).queryByText('evaled')).not.toBeInTheDocument();
    expect(within(container).getByText('1 fields')).toBeInTheDocument();
  });

  it('filters to search-time only when Search-time pill is clicked', () => {
    const { container } = render(<FieldsTab />);
    fireEvent.click(within(container).getByRole('button', { name: 'Search-time' }));
    expect(within(container).queryByText('idx_field')).not.toBeInTheDocument();
    expect(within(container).getByText('ext_field')).toBeInTheDocument();
    expect(within(container).getByText('evaled')).toBeInTheDocument();
    expect(within(container).getByText('2 fields')).toBeInTheDocument();
  });

  it('filters by name when searching', () => {
    const { container } = render(<FieldsTab />);
    const search = within(container).getByPlaceholderText('Search fields...');
    fireEvent.change(search, { target: { value: 'ext' } });
    expect(within(container).getByText('ext_field')).toBeInTheDocument();
    expect(within(container).queryByText('idx_field')).not.toBeInTheDocument();
  });
});

describe('FieldsTab — accessibility (#320)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    useAppStore.setState({ processingResult: result });
  });

  it('marks the selected phase filter as pressed', () => {
    const { container } = render(<FieldsTab />);
    const all = within(container).getByRole('button', { name: 'All' });
    const index = within(container).getByRole('button', { name: 'Index-time' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(index).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(index);
    expect(all).toHaveAttribute('aria-pressed', 'false');
    expect(index).toHaveAttribute('aria-pressed', 'true');
  });

  it('exposes the sort order on the sorted column only', () => {
    const { container } = render(<FieldsTab />);
    const header = (label: string) => within(container).getByRole('columnheader', { name: new RegExp(`^${label}`) });
    expect(header('Events')).toHaveAttribute('aria-sort', 'descending');
    expect(header('Field Name')).not.toHaveAttribute('aria-sort');

    fireEvent.click(within(container).getByRole('button', { name: 'Field Name' }));
    expect(header('Field Name')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Events')).not.toHaveAttribute('aria-sort');

    fireEvent.click(within(container).getByRole('button', { name: 'Field Name' }));
    expect(header('Field Name')).toHaveAttribute('aria-sort', 'descending');
  });
});

describe('FieldsTab — nested field counts (#316)', () => {
  it('counts each collapsed parent\'s immediate children', () => {
    useAppStore.setState(initial, true);
    const json = makeEvent(
      { a: '{}', 'a.b': '{}', 'a.b.c': '1', 'a.b.d': '2', 'a.e': '3', z: 'x' },
      [],
    );
    useAppStore.setState({
      processingResult: { events: [json], originalRaw: '', eventCount: 1, processingSteps: [], inputMetadata: { index: 'main', host: '', source: '', sourcetype: '' } },
    });
    const { container } = render(<FieldsTab />);
    // Parents collapse on load, so only `a` and `z` show, with a's two
    // immediate children (a.b, a.e) counted — not a.b's own.
    expect(within(container).getByText('(2)')).toBeInTheDocument();
    fireEvent.click(within(container).getByRole('button', { name: 'Expand a' }));
    const expands = within(container).getAllByRole('button', { name: /^Expand / });
    expect(expands).toHaveLength(1); // a.b, still collapsed
    expect(within(container).getByText('(2)')).toBeInTheDocument();
  });

  // #335: every toggle was a bare "Expand"/"Collapse" with no state, so a
  // screen reader heard a column of identical buttons.
  it('names each toggle for its field and announces its state', () => {
    useAppStore.setState(initial, true);
    const json = makeEvent({ a: '{}', 'a.b': '{}', 'a.b.c': '1' }, []);
    useAppStore.setState({
      processingResult: { events: [json], originalRaw: '', eventCount: 1, processingSteps: [], inputMetadata: { index: 'main', host: '', source: '', sourcetype: '' } },
    });
    const { container } = render(<FieldsTab />);
    const top = within(container).getByRole('button', { name: 'Expand a' });
    expect(top).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(top);
    expect(within(container).getByRole('button', { name: 'Collapse a' })).toHaveAttribute('aria-expanded', 'true');

    // The nested toggle carries the full dotted name, not just its leaf.
    const nested = within(container).getByRole('button', { name: 'Expand a.b' });
    expect(nested).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('FieldsTab — column resize teardown (#322)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    useAppStore.setState({ processingResult: result });
  });

  it('restores the page and drops its listeners when unmounted mid-drag', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { container, unmount } = render(<FieldsTab />);
    fireEvent.mouseDown(within(container).getByRole('separator', { name: 'Resize Events column' }), { clientX: 100 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('still ends a drag on mouseup', () => {
    const { container } = render(<FieldsTab />);
    fireEvent.mouseDown(within(container).getByRole('separator', { name: 'Resize Events column' }), { clientX: 100 });
    fireEvent.mouseUp(document);
    expect(document.body.style.cursor).toBe('');
  });
});
