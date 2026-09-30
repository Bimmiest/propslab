// @vitest-environment jsdom
// The mobile panel is store state, so a jump to an editor line from Output can
// switch to that editor (#432).
//
// Every panel is the real one (#507). Each used to be replaced by a `<div>`
// with its own name in it, so the tests only proved that MobileShell renders
// whatever it is handed. A panel is now recognised by something only it draws:
// the Raw panel's scaffold button, the props editor's collapse button, the
// output panel's own tabpanel. The one thing not real is the editor behind the
// props header. LazyEditors loads Monaco on demand and nothing here waits for
// it, so the editor slot shows its loading fallback; Monaco itself is exercised
// by the editor test files and the Playwright suite.
import { describe, it, expect, beforeEach } from 'vitest';
import { render as baseRender, screen, act, fireEvent } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement } from 'react';
import { MobileShell } from '../MobileShell';
import { useAppStore } from '../../../store/useAppStore';
import { revealInEditor } from '../../editor/revealInEditor';

const initial = useAppStore.getState();

// The tooltip provider is at the app's root in production; AppShell sits inside it.
const render = (ui: ReactElement) => baseRender(<RadixTooltip.Provider>{ui}</RadixTooltip.Provider>);

describe('MobileShell', () => {
  beforeEach(() => useAppStore.setState(initial, true));

  it('switches from Output to the editor a jump targets', () => {
    render(<MobileShell />);
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }));
    expect(screen.getByRole('tablist', { name: 'Output tabs' })).toBeInTheDocument();
    expect(screen.queryByTitle('Collapse props.conf')).not.toBeInTheDocument();

    act(() => revealInEditor('props.conf', 4));
    expect(screen.getByRole('tab', { name: 'props' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTitle('Collapse props.conf')).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Output tabs' })).not.toBeInTheDocument();
  });

  it('shows the Raw panel first', () => {
    render(<MobileShell />);
    expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTitle('Scaffold a starter props.conf from this sample')).toBeInTheDocument();
  });
});

describe('MobileShell aria-controls (#495)', () => {
  beforeEach(() => useAppStore.setState(initial, true));

  it('only the active tab points at a panel, since only that panel is mounted', () => {
    render(<MobileShell />);
    const tabs = screen.getAllByRole('tab');
    for (const tab of tabs) {
      const selected = tab.getAttribute('aria-selected') === 'true';
      if (selected) {
        const id = tab.getAttribute('aria-controls');
        expect(id).toBeTruthy();
        expect(document.getElementById(id!)).toHaveAttribute('role', 'tabpanel');
      } else {
        expect(tab).not.toHaveAttribute('aria-controls');
      }
    }
  });
});
