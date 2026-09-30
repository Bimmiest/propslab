// @vitest-environment jsdom
// Dismissing the banner unmounts the button that had focus; focus must land
// somewhere useful rather than on <body> (#495).
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FirstRunBanner } from '../FirstRunBanner';

describe('FirstRunBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('hands focus to the main region when it is dismissed', () => {
    render(
      <>
        <FirstRunBanner />
        <main id="main-content" tabIndex={-1}>
          workspace
        </main>
      </>,
    );
    const dismiss = screen.getByRole('button', { name: 'Dismiss welcome banner' });
    dismiss.focus();
    fireEvent.click(dismiss);

    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('remembers the dismissal', () => {
    const { unmount } = render(<FirstRunBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss welcome banner' }));
    unmount();
    render(<FirstRunBanner />);
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
  });
});
