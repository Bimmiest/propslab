// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsPanel } from '../SettingsPanel';
import { useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({ ...initial, settingsOpen: true }, true);
});

describe('SettingsPanel — the pipeline text', () => {
  it('says what the re-match does and why it is off by default', () => {
    render(<SettingsPanel />);
    expect(
      screen.getByText(
        'Run stanza matching again after a transform rewrites the sourcetype, host or source. Off by default, because it runs the pipeline per event.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/simulates/i)).not.toBeInTheDocument();
  });

  it('never names a per-event mode, which has no control in the panel', () => {
    const { rerender } = render(<SettingsPanel />);
    expect(screen.getByText(/Recommended when stanza matching runs again/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/per-event mode/);

    useAppStore.getState().togglePerEventPipeline();
    rerender(<SettingsPanel />);
    expect(screen.getByText(/Required while stanza matching runs again/)).toBeInTheDocument();
    expect(screen.getByText(/The pipeline runs for each event/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/per-event mode/);
  });
});
