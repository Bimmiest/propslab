// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ArchitecturePanel } from '../ArchitecturePanel';
import type { EventMetadata } from '../../../engine/types';

const reveal = vi.hoisted(() => vi.fn());
vi.mock('../../editor/revealInEditor', () => ({ revealInEditor: reveal }));

const metadata: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function renderPanel(propsConf: string, embedded = true) {
  return render(<ArchitecturePanel inputs={{ propsConf, transformsConf: '', metadata }} embedded={embedded} />);
}

const box = (name: string) => screen.getByRole('region', { name });

describe('ArchitecturePanel (#901)', () => {
  it('lists the directives of each tier by stanza, and marks the tiers the config uses', () => {
    renderPanel('[web]\nTIME_FORMAT = %s\nEXTRACT-a = (?<a>x)\nEVAL-b = 1\n');

    const hf = box('Heavy forwarder');
    expect(within(hf).getByRole('heading', { level: 3, name: '[web]' })).toBeInTheDocument();
    expect(within(hf).getByRole('button', { name: /^TIME_FORMAT = %s/ })).toBeInTheDocument();
    expect(within(hf).getByText('Used: 1 directive')).toBeInTheDocument();

    const sh = box('Search head');
    expect(
      within(sh)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['EXTRACT-a = (?<a>x) line 3', 'EVAL-b = 1 line 4']);
    expect(within(sh).getByText('Used: 2 directives')).toBeInTheDocument();

    // The indexer parses when no heavy forwarder is on the path.
    const indexer = box('Indexer');
    expect(indexer).toHaveAttribute('data-used', 'true');
    expect(within(indexer).getByText(/Runs the 1 directive of the heavy forwarder/)).toBeInTheDocument();

    const uf = box('Universal forwarder');
    expect(uf).toHaveAttribute('data-used', 'false');
    expect(within(uf).getByText('Not used by this config')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Tier not known' })).not.toBeInTheDocument();
  });

  it('jumps to the line of a directive in props.conf', () => {
    renderPanel('[web]\nCHARSET = UTF-8\nKV_MODE = json\n');
    fireEvent.click(within(box('Search head')).getByRole('button', { name: /^KV_MODE/ }));
    expect(reveal).toHaveBeenLastCalledWith('props.conf', 3);
    fireEvent.click(within(box('Universal forwarder')).getByRole('button', { name: /^CHARSET/ }));
    expect(reveal).toHaveBeenLastCalledWith('props.conf', 2);
  });

  it('lists a directive whose tier is not known with the reason, and still jumps to it', () => {
    renderPanel('[csv]\nINDEXED_EXTRACTIONS = csv\n');
    const unknownBox = box('Tier not known');
    expect(within(unknownBox).getByText(/only for the XML formats/)).toBeInTheDocument();
    fireEvent.click(within(unknownBox).getByRole('button', { name: /^INDEXED_EXTRACTIONS/ }));
    expect(reveal).toHaveBeenLastCalledWith('props.conf', 2);
    // Nothing else in the config, so no tier is used.
    expect(box('Indexer')).toHaveAttribute('data-used', 'false');
  });

  it('marks only the indexer for SEGMENTATION', () => {
    renderPanel('[st]\nSEGMENTATION = inner\n');
    expect(box('Indexer')).toHaveAttribute('data-used', 'true');
    expect(within(box('Indexer')).getByText('Used: 1 directive')).toBeInTheDocument();
    expect(box('Heavy forwarder')).toHaveAttribute('data-used', 'false');
  });

  it('with no props.conf, shows every tier unused and says what to add', () => {
    renderPanel('', false);
    expect(screen.getByText(/Add props.conf directives/)).toBeInTheDocument();
    for (const name of ['Universal forwarder', 'Heavy forwarder', 'Indexer', 'Search head']) {
      expect(box(name)).toHaveAttribute('data-used', 'false');
    }
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // Standalone, the panel has its own title bar.
    expect(screen.getByText('Architecture')).toBeInTheDocument();
  });
});
