// @vitest-environment jsdom
// Dismissing the banner unmounts the button that had focus; focus must land
// somewhere useful rather than on <body> (#495).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FirstRunBanner } from '../FirstRunBanner';

describe('FirstRunBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('hands focus to the main region when it is dismissed', () => {
    render(
      <>
        <FirstRunBanner />
        <main id="main-content" tabIndex={-1}>
          workspace
        </main>
      </>,
    );
    const dismiss = screen.getByRole('button', { name: 'Got it: dismiss the welcome banner' });
    dismiss.focus();
    fireEvent.click(dismiss);

    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('remembers the dismissal', () => {
    const { unmount } = render(<FirstRunBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Got it: dismiss the welcome banner' }));
    unmount();
    render(<FirstRunBanner />);
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
  });

  it('stays hidden when storage cannot be read, rather than greeting every visit', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    render(<FirstRunBanner />);
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
  });

  it('stays hidden for a returning user who saw it under the old name', () => {
    localStorage.setItem('splunk-toolkit:seen-intro', 'true');
    render(<FirstRunBanner />);
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
  });
});

describe('FirstRunBanner — one row, no dangling arrow', () => {
  beforeEach(() => localStorage.clear());

  it('numbers the three steps and draws no arrows between them', () => {
    const { container } = render(<FirstRunBanner />);
    for (const n of ['1', '2', '3']) expect(screen.getByText(n)).toBeInTheDocument();
    expect(container.querySelector('svg path[d="M13 7l5 5m0 0l-5 5m5-5H6"]')).toBeNull();
  });

  it('shows the descriptions only where all three fit on one row', () => {
    render(<FirstRunBanner />);
    expect(screen.getByText('Drop log lines into the Raw Log panel on the left').className).toContain(
      'min-[1500px]:inline',
    );
  });
});
