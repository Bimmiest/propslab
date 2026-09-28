// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// Overlay.test.tsx
// The three overlay guarantees Radix provides: topmost-only Escape, the focus
// trap, and background inertness.
//
// A layout-based check silently matches nothing under jsdom (`offsetParent` is
// always null here), so each assertion below is written to fail if the
// behaviour disappears, not merely to pass while Radix does nothing.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { Overlay } from '../Overlay';

describe('Overlay', () => {
  it('renders its children when open', () => {
    render(
      <Overlay open onClose={() => {}} label="Test dialog">
        <button>Inside</button>
      </Overlay>,
    );
    expect(screen.getByRole('button', { name: 'Inside' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(
      <Overlay open={false} onClose={() => {}} label="Test dialog">
        <button>Inside</button>
      </Overlay>,
    );
    expect(screen.queryByRole('button', { name: 'Inside' })).not.toBeInTheDocument();
  });

  it('is exposed as a dialog with its label', () => {
    render(
      <Overlay open onClose={() => {}} label="Command palette">
        <button>Inside</button>
      </Overlay>,
    );
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Overlay open onClose={onClose} label="Test dialog">
        <button>Inside</button>
      </Overlay>,
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes only the topmost overlay on Escape', () => {
    // The defect the hook's layer stack existed to fix: one Escape closing two
    // layers at once. Radix's dismissable-layer stack has to keep doing it.
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Overlay open onClose={closeOuter} label="Outer">
          <button>Outer button</button>
        </Overlay>
        <Overlay open onClose={closeInner} label="Inner">
          <button>Inner button</button>
        </Overlay>
      </>,
    );

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it('moves focus into the overlay when it opens', () => {
    render(
      <>
        <button>Outside</button>
        <Overlay open onClose={() => {}} label="Test dialog">
          <button>Inside</button>
        </Overlay>
      </>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('hides the rest of the app from assistive tech while open', () => {
    // Background inertness was the third thing the hook did by hand, and the one
    // whose absence is invisible without a screen reader.
    const { baseElement } = render(
      <>
        <div data-testid="app">
          <button>Outside</button>
        </div>
        <Overlay open onClose={() => {}} label="Test dialog">
          <button>Inside</button>
        </Overlay>
      </>,
    );

    const appSibling = baseElement.querySelector('[data-testid="app"]')?.parentElement;
    expect(appSibling?.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves Escape alone once closed', () => {
    // A closed overlay left in the tree keeps Radix's DismissableLayer, whose
    // capture-phase handler preventDefaults every Escape in the document —
    // which, among other things, stopped Escape clearing a search field.
    const { rerender } = render(
      <>
        <input type="search" aria-label="Search" />
        <Overlay open onClose={() => {}} label="Test dialog">
          <button>Inside</button>
        </Overlay>
      </>,
    );
    rerender(
      <>
        <input type="search" aria-label="Search" />
        <Overlay open={false} onClose={() => {}} label="Test dialog">
          <button>Inside</button>
        </Overlay>
      </>,
    );
    const notPrevented = fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Escape' });
    expect(notPrevented).toBe(true);
    expect(screen.getByLabelText('Search').closest('[aria-hidden="true"]')).toBeNull();
  });

  it('forwards a keydown handler to the content, for Enter-to-submit', () => {
    const onKeyDown = vi.fn();
    render(
      <Overlay open onClose={() => {}} label="Test dialog" onKeyDown={onKeyDown}>
        <input aria-label="field" />
      </Overlay>,
    );
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalled();
  });

  it('applies the caller class and style to the content element', () => {
    render(
      <Overlay open onClose={() => {}} label="Test dialog" className="max-w-lg" style={{ zIndex: 51 }}>
        <button>Inside</button>
      </Overlay>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('max-w-lg');
    expect(dialog).toHaveStyle({ zIndex: '51' });
  });
});
