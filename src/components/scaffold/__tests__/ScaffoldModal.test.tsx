// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScaffoldModal } from '../ScaffoldModal';
import { useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();

const SYSLOG = [
  '2024-03-01T10:00:00Z host1 sshd[123]: Accepted password for alice',
  '2024-03-01T10:00:05Z host1 sshd[124]: Failed password for bob',
  '2024-03-01T10:00:09Z host2 cron[55]: job started',
].join('\n');

function renderOpen(rawData: string) {
  useAppStore.setState({ rawData, scaffoldOpen: true });
  return render(<ScaffoldModal />);
}

const append = () => screen.getByRole('button', { name: 'Append to props.conf' });
const nameField = () => screen.getByLabelText('Sourcetype (stanza name)');
const suggestion = (key: string) => screen.getByRole('checkbox', { name: new RegExp(`^${key} = `) });

describe('ScaffoldModal', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('asks for sample data when there is none, and has nothing to append', () => {
    renderOpen('  \n');
    expect(screen.getByText('Paste raw log data first, then reopen Scaffold.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(append()).toBeDisabled();
  });

  it('suggests directives for a sample, checked by default, with a preview of the stanza', () => {
    renderOpen(SYSLOG);
    expect(suggestion('TIME_FORMAT')).toBeChecked();
    expect(nameField()).toHaveValue('my:sourcetype');
    expect(screen.getByText(/props\.conf preview/)).toHaveTextContent('[my:sourcetype]');
    expect(append()).toBeEnabled();
  });

  it('blocks a stanza name that would not parse as one header', () => {
    renderOpen(SYSLOG);
    fireEvent.change(nameField(), { target: { value: 'foo]bar' } });
    expect(screen.getByText(/Stanza name cannot contain "\[" or "\]"/)).toBeInTheDocument();
    expect(append()).toBeDisabled();
    fireEvent.click(append());
    expect(useAppStore.getState().propsConf).toBe(initial.propsConf);
  });

  it('appends the checked suggestions under the chosen name, points the sourcetype at it, and closes', () => {
    useAppStore.setState({ propsConf: '[existing]\nKV_MODE = none\n' });
    renderOpen(SYSLOG);
    const timeFormat = suggestion('TIME_FORMAT');
    fireEvent.click(timeFormat);
    expect(timeFormat).not.toBeChecked();
    fireEvent.change(nameField(), { target: { value: 'syslog:test' } });

    fireEvent.click(append());

    const { propsConf, metadata, scaffoldOpen } = useAppStore.getState();
    // With TIME_FORMAT unchecked, the other default is all the stanza holds.
    expect(propsConf).toMatch(/^\[existing\]\nKV_MODE = none\n\n\[syslog:test\]\nMAX_TIMESTAMP_LOOKAHEAD = \d+\n$/);
    expect(metadata.sourcetype).toBe('syslog:test');
    expect(scaffoldOpen).toBe(false);
  });
});
