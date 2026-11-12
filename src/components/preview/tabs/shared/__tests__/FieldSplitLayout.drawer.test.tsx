// @vitest-environment jsdom
// On a phone the Extractions field list is a drawer over the events, not a
// column beside them (#893).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FieldSplitLayout } from '../FieldSplitLayout';
import { MOBILE_QUERY } from '../../../../../hooks/useMediaQuery';

function stubWidth(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === MOBILE_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('FieldSplitLayout on a phone', () => {
  beforeEach(() => stubWidth(true));

  it('shows the sidebar over the events, with no resize handle', () => {
    const { container } = render(
      <FieldSplitLayout storageKey="drawer" collapsed={false} sidebar={<input aria-label="Filter fields" />}>
        <p>events</p>
      </FieldSplitLayout>,
    );
    const drawer = screen.getByRole('textbox', { name: 'Filter fields' }).parentElement;
    expect(drawer).toHaveClass('absolute', 'right-0');
    expect(screen.getByRole('region', { name: 'Events' })).toHaveTextContent('events');
    expect(container.querySelector('[data-panel-resize-handle-id], [role="separator"]')).toBeNull();
  });

  it('shows no drawer while the sidebar is hidden', () => {
    render(
      <FieldSplitLayout storageKey="drawer" collapsed sidebar={<input aria-label="Filter fields" />}>
        <p>events</p>
      </FieldSplitLayout>,
    );
    expect(screen.queryByRole('textbox', { name: 'Filter fields' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Events' })).toBeInTheDocument();
  });

  it('closes on Escape from inside it, and keeps that Escape from what holds it', () => {
    const onCollapse = vi.fn();
    const outer = vi.fn();
    render(
      // A stand-in for the tab around it, which must not also act on the key.
      <div
        onKeyDown={(e) => {
          outer(e.key);
        }}
      >
        <FieldSplitLayout
          storageKey="drawer"
          collapsed={false}
          sidebar={<input aria-label="Filter fields" />}
          onCollapse={onCollapse}
        >
          <p>events</p>
        </FieldSplitLayout>
      </div>,
    );
    const input = screen.getByRole('textbox', { name: 'Filter fields' });
    fireEvent.keyDown(input, { key: 'a' });
    expect(onCollapse).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCollapse).toHaveBeenCalledOnce();
    expect(outer.mock.calls).toEqual([['a']]);
  });
});

describe('FieldSplitLayout wider than a phone', () => {
  beforeEach(() => stubWidth(false));

  it('keeps the sidebar a resizable column', () => {
    render(
      <FieldSplitLayout storageKey="column" collapsed={false} sidebar={<input aria-label="Filter fields" />}>
        <p>events</p>
      </FieldSplitLayout>,
    );
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Filter fields' }).parentElement).not.toHaveClass('absolute');
  });
});
