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
