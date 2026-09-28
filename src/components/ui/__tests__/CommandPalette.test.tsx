// @vitest-environment jsdom
// "Load: <example>" and "Clear all editors" replace every input at once, so
// they ask first — but only when that would lose something (#440).
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CommandPalette } from '../CommandPalette';
import { useAppStore } from '../../../store/useAppStore';
import { SAMPLE_CONFIGS } from '../../../engine/sampleData';

const initial = useAppStore.getState();
const sample = SAMPLE_CONFIGS[0]!;

function openPalette() {
  render(<CommandPalette />);
  act(() => useAppStore.getState().toggleCommandPalette());
}

function choose(label: string) {
  fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${label}`) }));
}

describe('CommandPalette — replacing the inputs', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('loads an example straight away into an untouched session', () => {
    openPalette();
    choose(`Load: ${sample.name}`);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(useAppStore.getState().rawData).toBe(sample.rawData);
  });

  it('loads over an example that has not been edited without asking', () => {
    useAppStore.getState().loadInputs(SAMPLE_CONFIGS[1]!);
    openPalette();
    choose(`Load: ${sample.name}`);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(useAppStore.getState().rawData).toBe(sample.rawData);
  });

  it('asks before an example overwrites edited work, and Cancel keeps it', () => {
    useAppStore.getState().setPropsConf('[mine]\nTRUNCATE = 0');
    openPalette();
    choose(`Load: ${sample.name}`);

    const dialog = screen.getByRole('alertdialog', { name: 'Replace your current work?' });
    expect(dialog).toHaveTextContent(sample.name);
    // The palette gives way to the confirmation rather than stacking under it.
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    // Cancel is the focused default: an accidental Enter must not discard work.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(useAppStore.getState().propsConf).toBe('[mine]\nTRUNCATE = 0');
  });

  it('replaces edited work once confirmed', () => {
    useAppStore.getState().setMetadataField('host', 'web01');
    openPalette();
    choose(`Load: ${sample.name}`);
    fireEvent.click(screen.getByRole('button', { name: 'Load example' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(useAppStore.getState().metadata).toEqual(sample.metadata);
    expect(useAppStore.getState().propsConf).toBe(sample.propsConf);
  });

  it('asks before "Clear all editors" discards edited work', () => {
    useAppStore.getState().setRawData('my events');
    openPalette();
    choose('Clear all editors');
    expect(useAppStore.getState().rawData).toBe('my events');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(useAppStore.getState().rawData).toBe('');
  });

  it('closes the confirmation on Escape without replacing anything', () => {
    useAppStore.getState().setRawData('my events');
    openPalette();
    choose('Clear all editors');
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(useAppStore.getState().rawData).toBe('my events');
  });
});
