// @vitest-environment jsdom
// The mobile panel is store state, so a jump to an editor line from Output can
// switch to that editor (#432).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MobileShell } from '../MobileShell';
import { useAppStore } from '../../../store/useAppStore';
import { revealInEditor } from '../../editor/revealInEditor';

vi.mock('../../raw/RawPanel', () => ({ RawPanel: () => <div>raw panel</div> }));
vi.mock('../../editor/PropsConfEditor', () => ({ PropsConfEditor: () => <div>props editor</div> }));
vi.mock('../../editor/TransformsConfEditor', () => ({ TransformsConfEditor: () => <div>transforms editor</div> }));
vi.mock('../../preview/PreviewPanel', () => ({ PreviewPanel: () => <div>output panel</div> }));
vi.mock('../lazyViews', () => ({ DictionaryView: () => <div>dictionary</div> }));

const initial = useAppStore.getState();

describe('MobileShell', () => {
  beforeEach(() => useAppStore.setState(initial, true));

  it('switches from Output to the editor a jump targets', () => {
    render(<MobileShell />);
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }));
    expect(screen.getByText('output panel')).toBeInTheDocument();

    act(() => revealInEditor('props.conf', 4));
    expect(screen.getByRole('tab', { name: 'props' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('props editor')).toBeInTheDocument();
  });
});
