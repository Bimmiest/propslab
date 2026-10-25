// @vitest-environment jsdom
// The metadata dialog (#693): opened from the Raw Log header, it edits the
// store as you type, and the button shows the sourcetype.

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MetadataButton } from '../MetadataButton';
import { useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();
beforeEach(() => {
  useAppStore.setState(initial, true);
});

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Metadata/ }));
  return screen.getByRole('dialog', { name: 'Metadata' });
};

describe('MetadataButton', () => {
  it('edits the four fields in a dialog, and the button shows the sourcetype', () => {
    render(<MetadataButton />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const dialog = openDialog();
    for (const [label, value] of [
      ['index', 'web'],
      ['host', 'web-01'],
      ['source', '/var/log/access.log'],
      ['sourcetype', 'access_combined'],
    ] as const) {
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
      expect(useAppStore.getState().metadata[label]).toBe(value);
    }
    expect(within(dialog).getByLabelText('sourcetype')).toHaveAccessibleDescription(/\[sourcetype\] stanzas/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Metadata access_combined' })).toBeInTheDocument();
  });

  it('closes on Enter in a field, and keeps what was typed', () => {
    render(<MetadataButton />);
    const field = within(openDialog()).getByLabelText('host');
    fireEvent.change(field, { target: { value: 'fw-01' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useAppStore.getState().metadata.host).toBe('fw-01');
  });
});
