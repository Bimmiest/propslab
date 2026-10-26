// @vitest-environment jsdom
// The About dialog (#739): the build this page runs, and where the project lives.

import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { AboutDialog } from '../AboutDialog';
import { useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();
beforeEach(() => {
  useAppStore.setState(initial, true);
});

const REPO = 'https://github.com/Bimmiest/propslab';
const SHA = '0000000000000000000000000000000000000000';

function renderOpen() {
  render(
    <RadixTooltip.Provider>
      <AboutDialog />
    </RadixTooltip.Provider>,
  );
  act(() => useAppStore.getState().toggleAbout());
  return screen.getByRole('dialog', { name: 'About Propslab' });
}

describe('AboutDialog', () => {
  it('is closed until the store opens it', () => {
    render(<AboutDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the version, and links the full commit to GitHub', () => {
    const dialog = renderOpen();
    expect(within(dialog).getByText('test')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: SHA })).toHaveAttribute('href', `${REPO}/commit/${SHA}`);
    expect(within(dialog).getByText('Propslab test, build 0000000')).toBeInTheDocument();
    expect(dialog.querySelector('time')).toHaveAttribute('dateTime', '2026-01-02T03:04:05.000Z');
  });

  it('links the repository, the changelog, issues, the security policy and the licence', () => {
    const dialog = renderOpen();
    const hrefs = within(dialog)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      `${REPO}/commit/${SHA}`,
      REPO,
      `${REPO}/blob/main/CHANGELOG.md`,
      `${REPO}/issues/new/choose`,
      `${REPO}/blob/main/SECURITY.md`,
      `${REPO}/blob/main/LICENSE`,
    ]);
    for (const link of within(dialog).getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer');
    }
  });

  it('closes from its button', () => {
    const dialog = renderOpen();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(useAppStore.getState().aboutOpen).toBe(false);
  });
});
