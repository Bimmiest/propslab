// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { FieldSplitLayout } from '../FieldSplitLayout';

const KEY = 'test-split-layout';

// JSON.parse succeeds for plenty of values that are not a Layout, so the
// stored value is validated before it reaches the panel group.
describe('FieldSplitLayout — persisted layout is shape-checked (#35.3)', () => {
  beforeEach(() => localStorage.clear());

  const renderWith = (saved: string) => {
    localStorage.setItem(KEY, saved);
    return render(
      <FieldSplitLayout storageKey={KEY} collapsed={false} sidebar={<div>side</div>}>
        <div>body</div>
      </FieldSplitLayout>,
    );
  };

  it.each([
    ['null', 'null'],
    ['an array', '[1,2]'],
    ['wrong value types', '{"events":"x","sidebar":"y"}'],
    ['missing keys', '{"foo":1}'],
    ['malformed json', '{not json'],
  ])('falls back to the default for %s', (_label, saved) => {
    const { getByText } = renderWith(saved);
    expect(getByText('body')).toBeInTheDocument();
  });

  it('uses a well-formed saved layout', () => {
    const { getByText } = renderWith(`{"${KEY}-events":70,"${KEY}-sidebar":30}`);
    expect(getByText('body')).toBeInTheDocument();
    expect(getByText('side')).toBeInTheDocument();
  });
});

// react-resizable-panels keys a Layout by panel id, and saves it that way, so
// a layout checked against any other keys never restored (#432).
describe('FieldSplitLayout — restores the saved split (#432)', () => {
  beforeEach(() => localStorage.clear());

  const flexGrow = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[id="${id}"]`)?.style.flexGrow;

  const renderLayout = () => render(
    <FieldSplitLayout storageKey={KEY} collapsed={false} sidebar={<div>side</div>}>
      <div>body</div>
    </FieldSplitLayout>,
  );

  it('sizes the panels from a layout keyed by panel id', () => {
    localStorage.setItem(KEY, JSON.stringify({ [`${KEY}-events`]: 70, [`${KEY}-sidebar`]: 30 }));
    const { container } = renderLayout();
    expect(flexGrow(container, `${KEY}-events`)).toBe('70');
    expect(flexGrow(container, `${KEY}-sidebar`)).toBe('30');
  });

  it('ignores a layout keyed by anything else', () => {
    localStorage.setItem(KEY, '{"events":70,"sidebar":30}');
    const { container } = renderLayout();
    expect(flexGrow(container, `${KEY}-events`)).not.toBe('70');
  });
});

// A long event overflows the pane with nothing focusable inside; axe's
// scrollable-region-focusable flagged it once a wide JSON event was loaded.
describe('FieldSplitLayout — the events pane is reachable by keyboard', () => {
  for (const collapsed of [false, true]) {
    it(`is a named tab stop with the sidebar ${collapsed ? 'hidden' : 'shown'}`, () => {
      const { getByRole } = render(
        <FieldSplitLayout storageKey={KEY} collapsed={collapsed} sidebar={<div>side</div>}>
          <div>body</div>
        </FieldSplitLayout>,
      );
      const pane = getByRole('region', { name: 'Events' });
      expect(pane).toHaveAttribute('tabindex', '0');
      expect(pane).toHaveTextContent('body');
    });
  }
});

