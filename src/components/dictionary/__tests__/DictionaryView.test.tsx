// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { DictionaryView } from '../DictionaryView';
import { useAppStore } from '../../../store/useAppStore';

function renderDictionary() {
  return render(
    <RadixTooltip.Provider>
      <DictionaryView />
    </RadixTooltip.Provider>,
  );
}

const initial = useAppStore.getState();

describe('DictionaryView', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('shows a detail pane without waiting for a selection', () => {
    renderDictionary();
    // Falls back to the first visible entry, which is a stanza header.
    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
  });

  it('renders the entry the store points at', () => {
    useAppStore.setState({ dictionarySelection: 'TIME_FORMAT' });
    renderDictionary();
    expect(screen.getByRole('heading', { level: 2, name: 'TIME_FORMAT' })).toBeInTheDocument();
  });

  it('resolves a deep link to a key that exists once per conf file', () => {
    useAppStore.setState({ dictionarySelection: 'MATCH_LIMIT' });
    renderDictionary();
    expect(screen.getByRole('heading', { level: 2, name: 'MATCH_LIMIT' })).toBeInTheDocument();
  });

  it('shows the phase badge for the selected directive', () => {
    useAppStore.setState({ dictionarySelection: 'TIME_FORMAT' });
    renderDictionary();
    // TIME_FORMAT is index-time only.
    expect(screen.getAllByText('Index-time').length).toBeGreaterThan(0);
  });

  it('selects an entry when its row is clicked', () => {
    renderDictionary();
    const listbox = screen.getByRole('listbox');
    fireEvent.click(within(listbox).getByText('TRUNCATE'));
    expect(useAppStore.getState().dictionarySelection).toBe('TRUNCATE');
    expect(screen.getByRole('heading', { level: 2, name: 'TRUNCATE' })).toBeInTheDocument();
  });

  it('narrows the list as you search', () => {
    renderDictionary();
    const listbox = screen.getByRole('listbox');
    const before = within(listbox).getAllByRole('option').length;

    fireEvent.change(screen.getByLabelText('Search directives'), {
      target: { value: 'TIME_' },
    });

    const after = within(screen.getByRole('listbox')).getAllByRole('option').length;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  it('reports how many entries a filter left', () => {
    renderDictionary();
    fireEvent.change(screen.getByLabelText('Search directives'), {
      target: { value: 'TIME_PREFIX' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(/of \d+ entries/);
  });

  it('says so when nothing matches, instead of showing an empty list', () => {
    renderDictionary();
    fireEvent.change(screen.getByLabelText('Search directives'), {
      target: { value: 'zzzznotathing' },
    });
    expect(screen.getByText('No directives match these filters.')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps the selected entry rendered when a filter would exclude it', () => {
    useAppStore.setState({ dictionarySelection: 'TIME_FORMAT' });
    renderDictionary();
    fireEvent.click(screen.getByRole('button', { name: 'transforms' }));
    // TIME_FORMAT is props-only, so it leaves the list — but the pane the user
    // is reading must not blank out from under them.
    expect(screen.getByRole('heading', { level: 2, name: 'TIME_FORMAT' })).toBeInTheDocument();
  });

  it('walks the list with the arrow keys', () => {
    renderDictionary();
    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    const firstId = options[0]?.getAttribute('data-entry-id');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });

    expect(useAppStore.getState().dictionarySelection).not.toBe(firstId);
    expect(useAppStore.getState().dictionarySelection).toBe(
      options[1]?.getAttribute('data-entry-id'),
    );
  });

  it('points aria-activedescendant at the selected row', () => {
    useAppStore.setState({ dictionarySelection: 'TRUNCATE' });
    renderDictionary();
    const listbox = screen.getByRole('listbox');
    const active = listbox.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)).toHaveAttribute('data-entry-id', 'TRUNCATE');
  });

  it('drops aria-activedescendant when the selected entry is filtered out of the list', () => {
    // The detail pane keeps a filtered-out entry; the listbox must not point
    // assistive tech at an option it no longer renders.
    useAppStore.setState({ dictionarySelection: 'TIME_FORMAT' });
    renderDictionary();
    fireEvent.click(screen.getByRole('button', { name: 'transforms' }));
    const active = screen.getByRole('listbox').getAttribute('aria-activedescendant');
    expect(active).toBeNull();
  });

  it('documents stanza headers alongside directives', () => {
    useAppStore.setState({ dictionarySelection: 'stanza:source' });
    renderDictionary();
    expect(screen.getByRole('heading', { level: 2, name: '[source::<pattern>]' })).toBeInTheDocument();
    expect(screen.getByText(/Highest/)).toBeInTheDocument();
  });
});

describe('DictionaryView list badges', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('designates the conf file on every directive row, beside the phase', () => {
    renderDictionary();
    const listbox = screen.getByRole('listbox');
    const row = within(listbox).getByText('TIME_PREFIX').closest('[role="option"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('props')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Index-time')).toBeInTheDocument();
  });

  it('designates transforms-only directives as such', () => {
    renderDictionary();
    const listbox = screen.getByRole('listbox');
    const row = within(listbox).getByText('SOURCE_KEY').closest('[role="option"]');
    expect(within(row as HTMLElement).getByText('transforms')).toBeInTheDocument();
  });

  it('distinguishes the two MATCH_LIMIT rows by their conf file alone', () => {
    renderDictionary();
    const listbox = screen.getByRole('listbox');
    const rows = within(listbox)
      .getAllByText('MATCH_LIMIT')
      .map((el) => el.closest('[role="option"]') as HTMLElement);
    expect(rows).toHaveLength(2);
    // The key is bare in both; only the badge tells them apart.
    expect(rows.map((r) => within(r).getByText(/^(props|transforms)$/).textContent).sort())
      .toEqual(['props', 'transforms']);
  });
});

describe('DictionaryDetail layout', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('leads with the category as an eyebrow above the key', () => {
    useAppStore.setState({ dictionarySelection: 'KV_MODE' });
    renderDictionary();
    expect(screen.getAllByText('Field Extraction').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 2, name: 'KV_MODE' })).toBeInTheDocument();
  });

  it('labels the example card with the conf file it belongs in', () => {
    useAppStore.setState({ dictionarySelection: 'KV_MODE' });
    renderDictionary();
    // The card header names the file, so the snippet is never ambiguous about
    // which of the two editors it should be pasted into.
    expect(screen.getAllByText('props.conf').length).toBeGreaterThan(0);
  });

  it('shows the class-suffix explanation only for class-based keys', () => {
    useAppStore.setState({ dictionarySelection: 'EXTRACT' });
    const { unmount } = renderDictionary();
    expect(screen.getByText(/takes a class name suffix/)).toBeInTheDocument();
    unmount();

    useAppStore.setState({ dictionarySelection: 'TRUNCATE' });
    renderDictionary();
    expect(screen.queryByText(/takes a class name suffix/)).not.toBeInTheDocument();
  });

  it('omits the valid-values card for directives with no enum', () => {
    useAppStore.setState({ dictionarySelection: 'TRUNCATE' });
    renderDictionary();
    expect(screen.queryByText('Valid values')).not.toBeInTheDocument();
  });

  it('shows the valid-values card when the registry defines one', () => {
    useAppStore.setState({ dictionarySelection: 'KV_MODE' });
    renderDictionary();
    expect(screen.getByText('Valid values')).toBeInTheDocument();
    expect(screen.getByText('auto_escaped', { exact: true })).toBeInTheDocument();
  });
});

describe('DictionaryDetail adapts to how much an entry has to say', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('drops a stanza example that only restates the heading', () => {
    // `[default]` takes no pattern, so its registry example IS "[default]".
    useAppStore.setState({ dictionarySelection: 'stanza:default' });
    renderDictionary();
    expect(screen.queryByText('Example')).not.toBeInTheDocument();
  });

  it('keeps a stanza example that shows something new', () => {
    useAppStore.setState({ dictionarySelection: 'stanza:source' });
    renderDictionary();
    expect(screen.getByText('Example')).toBeInTheDocument();
  });

  it('still renders the single reference card when the layout collapses', () => {
    // One aside card does not earn a column, but it must not vanish either.
    useAppStore.setState({ dictionarySelection: 'stanza:default' });
    renderDictionary();
    expect(screen.getByText('Precedence')).toBeInTheDocument();
    expect(screen.getByText(/Lowest/)).toBeInTheDocument();
  });

  it('renders every reference card for a directive that has three', () => {
    useAppStore.setState({ dictionarySelection: 'KV_MODE' });
    renderDictionary();
    expect(screen.getByText('Specification')).toBeInTheDocument();
    expect(screen.getByText('Valid values')).toBeInTheDocument();
    expect(screen.getByText('Runs at')).toBeInTheDocument();
  });
});
