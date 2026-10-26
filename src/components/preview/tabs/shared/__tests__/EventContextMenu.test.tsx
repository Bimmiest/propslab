// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { EventContextMenu } from '../EventContextMenu';
import { useAppStore } from '../../../../../store/useAppStore';
import type { SplunkEvent } from '../../../../../engine/types';
import { makeEvent } from '../../../../../test/makeEvent';

const reveal = vi.hoisted(() => vi.fn());
vi.mock('../../../../editor/revealInEditor', () => ({ revealInEditor: reveal }));
const copied = vi.hoisted(() => vi.fn());
vi.mock('../../../../../utils/clipboard', () => ({ copyQuietly: copied }));

const initial = useAppStore.getState();

function event(): SplunkEvent {
  return makeEvent('status=200 user=alice', {
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: '' },
  });
}

// With a blank sourcetype the menu falls back to a placeholder stanza name.
// matchStanzas requires metadata.sourcetype === stanza.name, so the metadata is
// set too, or the config could never match the event it was scaffolded from.
describe('EventContextMenu — fallback stanza (#72)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    useAppStore.getState().setMetadataField('sourcetype', '');
  });

  function openExtractDialog() {
    render(
      <EventContextMenu event={event()} selectionText="alice" selectionStart={16}>
        <div>event body</div>
      </EventContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('event body'));
    fireEvent.click(screen.getByText(/Create EXTRACT/i));
  }

  it('points metadata at the stanza it wrote, so the directive can match', () => {
    openExtractDialog();
    fireEvent.click(screen.getByRole('button', { name: /Add EXTRACT/i }));

    const { propsConf, metadata } = useAppStore.getState();
    expect(propsConf).toContain('[my:sourcetype]');
    expect(metadata.sourcetype).toBe('my:sourcetype');
  });

  it('leaves an existing sourcetype alone', () => {
    useAppStore.getState().setMetadataField('sourcetype', 'app:api');
    openExtractDialog();
    fireEvent.click(screen.getByRole('button', { name: /Add EXTRACT/i }));

    const { propsConf, metadata } = useAppStore.getState();
    expect(propsConf).toContain('[app:api]');
    expect(metadata.sourcetype).toBe('app:api');
  });
});

describe("EventContextMenu — the event's metadata and stanzas (#759)", () => {
  const META = { index: 'main', host: 'web01', source: '/var/log/app.log', sourcetype: 'app:api' };

  beforeEach(() => {
    useAppStore.setState(initial, true);
    reveal.mockClear();
    copied.mockClear();
  });

  function openMenu() {
    render(
      <EventContextMenu event={makeEvent('status=200', { metadata: META })}>
        <div>event body</div>
      </EventContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('event body'));
    return screen.getByRole('menu');
  }

  it('copies the metadata as a search would write it', () => {
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Copy metadata' }));
    expect(copied).toHaveBeenCalledWith('index=main host=web01 source=/var/log/app.log sourcetype=app:api');
  });

  it("jumps to each stanza that applies to the event, from the editor's props.conf", () => {
    useAppStore
      .getState()
      .setPropsConf(
        '[other]\nKV_MODE = none\n\n[app:api]\nKV_MODE = json\n\n[source::/var/log/app.log]\nTRUNCATE = 0\n',
      );
    const menu = openMenu();
    const jumps = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent)
      .filter((t) => t.startsWith('Jump to'));
    expect(jumps.sort()).toEqual(['Jump to [app:api]', 'Jump to [source::/var/log/app.log]']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Jump to [app:api]' }));
    expect(reveal).toHaveBeenCalledWith('props.conf', 4);
  });

  it('says so when no stanza applies', () => {
    useAppStore.getState().setPropsConf('[other]\nKV_MODE = none\n');
    expect(
      within(openMenu()).getByRole('menuitem', { name: 'No stanza in props.conf matches this event' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });
});
