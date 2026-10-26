// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// tabMenus.test.tsx
// The context menus of the Effective config, CIM Models and Diff tabs (#761),
// and the FIELDALIAS dialog's second mode: a fixed alias, its source typed.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { EffectiveConfigTab } from '../EffectiveConfigTab';
import { CimModelsTab } from '../CimModelsTab';
import { DiffTab } from '../DiffTab';
import { FieldAliasDialog } from '../shared/FieldAliasDialog';
import { usePipelineInputs } from '../shared/usePipelineInputs';
import { useAppStore } from '../../../../store/useAppStore';
import { computeFieldStats } from '../../../../utils/fieldStats';
import { makeEvent } from '../../../../test/makeEvent';
import type { ViewResult } from '../../../../utils/viewResult';
import type { EnrichedEvent } from '../../enrichEvents';

const reveal = vi.hoisted(() => vi.fn());
vi.mock('../../../editor/revealInEditor', () => ({ revealInEditor: reveal }));
const copied = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/clipboard', () => ({
  copyQuietly: copied,
  copyToClipboard: vi.fn(() => Promise.resolve()),
}));

const initial = useAppStore.getState();
beforeEach(() => {
  useAppStore.setState(initial, true);
  reveal.mockClear();
  copied.mockClear();
});

const menuOn = (el: Element) => {
  fireEvent.contextMenu(el);
  return screen.getByRole('menu');
};
const choose = (menu: HTMLElement, name: string) => fireEvent.click(within(menu).getByRole('menuitem', { name }));

describe('Effective config — a directive row', () => {
  function Tab() {
    return <EffectiveConfigTab inputs={usePipelineInputs()} />;
  }

  beforeEach(() => {
    useAppStore.setState({
      propsConf: '[my_app]\nSHOULD_LINEMERGE = false\nTRUNCATE = 500\n',
      metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'my_app' },
    });
  });

  it('jumps to the directive, copies it, and looks it up', () => {
    render(<Tab />);
    choose(menuOn(screen.getByText('= 500')), 'Jump to config');
    expect(reveal).toHaveBeenCalledWith('props.conf', 3);
    choose(menuOn(screen.getByText('= 500')), 'Copy TRUNCATE = …');
    expect(copied).toHaveBeenCalledWith('TRUNCATE = 500');
    choose(menuOn(screen.getByText('= 500')), 'Look up TRUNCATE in the Dictionary');
    expect(useAppStore.getState()).toMatchObject({ activeView: 'dictionary', dictionarySelection: 'TRUNCATE' });
  });
});

describe('CIM Models — a missing field', () => {
  beforeEach(() => {
    const events = [makeEvent('', { fields: { src: '10.0.0.1', dest: '10.0.0.2' } })];
    useAppStore.setState({
      processingResult: {
        events,
        eventCount: 1,
        fieldStats: computeFieldStats(events),
        inputMetadata: { index: 'main', host: '', source: '', sourcetype: 'fw' },
      } as unknown as ViewResult,
    });
  });

  it('opens the FIELDALIAS dialog with the field as the alias, and the source is typed', () => {
    render(
      <>
        <CimModelsTab />
        <FieldAliasDialog />
      </>,
    );
    for (const card of screen.getAllByRole('button', { expanded: false })) fireEvent.click(card);
    const chip = screen.getAllByText('action')[0]!;

    choose(menuOn(chip), 'Copy field name');
    expect(copied).toHaveBeenCalledWith('action');
    choose(menuOn(chip), 'Create FIELDALIAS…');
    expect(useAppStore.getState().fieldAlias).toEqual({ alias: 'action' });

    const dialog = screen.getByRole('dialog', { name: 'Create FIELDALIAS' });
    expect(within(dialog).getByText('action')).toBeInTheDocument();
    // The events' fields are offered as the source.
    expect([...dialog.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(
      expect.arrayContaining(['dest', 'src']),
    );
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'src' } });
    expect(within(dialog).getByText('FIELDALIAS-action = src AS action')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add FIELDALIAS' }));
    expect(useAppStore.getState().propsConf).toContain('FIELDALIAS-action = src AS action');
  });

  it('copies the missing fields of the group', () => {
    render(<CimModelsTab />);
    for (const card of screen.getAllByRole('button', { expanded: false })) fireEvent.click(card);
    choose(menuOn(screen.getAllByText('action')[0]!), 'Copy the missing fields');
    expect(copied.mock.calls[0]?.[0]).toMatch(/(^|, )action(, |$)/);
  });
});

describe('Diff — a changed event', () => {
  const item = {
    event: { _raw: 'first\nCHANGED' },
    originalRaw: 'first\nchanged',
    hasChanges: true,
  } as unknown as EnrichedEvent;

  it('copies the right-clicked line, and the event before and after', () => {
    render(<DiffTab items={[item]} currentPage={1} eventsPerPage={10} />);
    choose(menuOn(screen.getByText('CHANGED')), 'Copy the line');
    expect(copied).toHaveBeenLastCalledWith('CHANGED');
    choose(menuOn(screen.getByText('CHANGED')), 'Copy the event before');
    expect(copied).toHaveBeenLastCalledWith('first\nchanged');
    choose(menuOn(screen.getByText('CHANGED')), 'Copy the event after');
    expect(copied).toHaveBeenLastCalledWith('first\nCHANGED');
  });
});
