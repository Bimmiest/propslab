// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// FieldMenuItems.test.tsx
// A field's context menu (#745): the shared actions, "Create FIELDALIAS…"
// through the one app dialog, and "Jump to config" to the directive.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../../../../ui/ContextMenu';
import { FieldMenuItems } from '../FieldMenuItems';
import { FieldAliasDialog } from '../FieldAliasDialog';
import { useAppStore } from '../../../../../store/useAppStore';

const reveal = vi.hoisted(() => vi.fn());
vi.mock('../../../../editor/revealInEditor', () => ({ revealInEditor: reveal }));

const initial = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initial, true);
  reveal.mockClear();
  useAppStore.getState().setMetadataField('sourcetype', 'web');
  useAppStore.getState().setPropsConf('[web]\nKV_MODE = none\nEXTRACT-user = user=(?<user>\\w+)\n');
});

function openMenu(props: Parameters<typeof FieldMenuItems>[0]) {
  render(
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <div>row</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <FieldMenuItems {...props} />
        </ContextMenuContent>
      </ContextMenu>
      <FieldAliasDialog />
    </>,
  );
  fireEvent.contextMenu(screen.getByText('row'));
  return screen.getByRole('menu');
}

describe('FieldMenuItems', () => {
  it('offers what each place knows: a value, sample values, pinning', () => {
    const menu = openMenu({ field: 'user', value: 'bob', onTogglePin: vi.fn(), pinned: true });
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items).toEqual([
      'Copy field name',
      'Copy value',
      'Copy field=value',
      'Unpin field',
      'Create FIELDALIAS…',
      'Jump to config',
    ]);
  });

  it('jumps to the directive that made the field', () => {
    const menu = openMenu({ field: 'user', sources: ['EXTRACT-user'] });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Jump to config' }));
    expect(reveal).toHaveBeenCalledWith('props.conf', 3);
  });

  it('disables the jump when no directive in props.conf made the field', () => {
    const menu = openMenu({ field: 'host', sources: ['metadata'] });
    expect(within(menu).getByRole('menuitem', { name: 'Jump to config' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('creates a FIELDALIAS in the stanza through the one dialog', () => {
    const menu = openMenu({ field: 'user' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Create FIELDALIAS…' }));
    const dialog = screen.getByRole('dialog', { name: 'Create FIELDALIAS' });
    const add = within(dialog).getByRole('button', { name: 'Add FIELDALIAS' });
    expect(add).toBeDisabled();

    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'user' } });
    expect(add).toBeDisabled();
    expect(within(dialog).getByText(/need different names/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'src user' } });
    expect(add).toBeDisabled();

    fireEvent.change(input, { target: { value: 'username' } });
    expect(within(dialog).getByText('FIELDALIAS-username = user AS username')).toBeInTheDocument();
    fireEvent.click(add);
    expect(useAppStore.getState().propsConf).toContain('FIELDALIAS-username = user AS username');
    expect(useAppStore.getState().fieldAlias).toBeNull();
  });
});
