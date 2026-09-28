// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventContextMenu } from '../EventContextMenu';
import { useAppStore } from '../../../../../store/useAppStore';
import type { SplunkEvent } from '../../../../../engine/types';

const initial = useAppStore.getState();

function event(): SplunkEvent {
  return {
    _raw: 'status=200 user=alice',
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: '' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
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
