// @vitest-environment jsdom
// The About dialog (#739, #940): the build this page runs, the engine in it,
// and where each lives.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { AboutDialog } from '../AboutDialog';
import { useAppStore } from '../../../store/useAppStore';

const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn((_text: string) => Promise.resolve()) }));
vi.mock('../../../utils/clipboard', () => clipboard);

const initial = useAppStore.getState();
beforeEach(() => {
  useAppStore.setState(initial, true);
});

const REPO = 'https://github.com/Bimmiest/propslab';
const SHA = '0000000000000000000000000000000000000000';
const ENGINE_REPO = 'https://github.com/Bimmiest/propslab-engine';
const ENGINE_SHA = '1111111111111111111111111111111111111111';
const LABEL = 'Propslab test, build 0000000; engine 0.0.0-test, build 1111111';

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
    expect(dialog.querySelector('time')).toHaveAttribute('dateTime', '2026-01-02T03:04:05.000Z');
  });

  it("shows the engine's version, and links the pinned engine commit", () => {
    const dialog = renderOpen();
    expect(within(dialog).getByText('0.0.0-test')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: ENGINE_SHA })).toHaveAttribute(
      'href',
      `${ENGINE_REPO}/commit/${ENGINE_SHA}`,
    );
  });

  it('shows the label for a bug report, which names the app and the engine', () => {
    const dialog = renderOpen();
    expect(dialog.querySelector('code')).toHaveTextContent(LABEL, { normalizeWhitespace: false });
  });

  it('copies the same label', async () => {
    const dialog = renderOpen();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy to clipboard' }));
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(LABEL);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Copied!' })).toBeInTheDocument());
  });

  it('links the sources, the changelogs, the issue forms, the security policy and the licence', () => {
    const dialog = renderOpen();
    const hrefs = within(dialog)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      `${REPO}/commit/${SHA}`,
      `${ENGINE_REPO}/commit/${ENGINE_SHA}`,
      REPO,
      `${REPO}/blob/main/CHANGELOG.md`,
      ENGINE_REPO,
      `${ENGINE_REPO}/blob/main/CHANGELOG.md`,
      `${REPO}/issues/new/choose`,
      `${ENGINE_REPO}/issues/new?template=fidelity-question.yml`,
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
