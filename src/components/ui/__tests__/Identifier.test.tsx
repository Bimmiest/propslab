// @vitest-environment jsdom
// A field or stanza name is case-sensitive, so no heading may upper-case it (#897).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as RadixContextMenu from '@radix-ui/react-context-menu';
import { Identifier } from '../Identifier';
import { ContextMenuLabel } from '../ContextMenu';

describe('Identifier', () => {
  it('shows the name as written, in the monospace style, and undoes a heading transform', () => {
    render(<Identifier>src_ip</Identifier>);
    const el = screen.getByText('src_ip');
    expect(el.tagName).toBe('CODE');
    expect(el).toHaveClass('font-mono', 'normal-case', 'tracking-normal');
  });
});

describe('ContextMenuLabel', () => {
  it('does not upper-case what it holds', () => {
    render(
      <RadixContextMenu.Root open>
        <RadixContextMenu.Trigger>t</RadixContextMenu.Trigger>
        <RadixContextMenu.Portal>
          <RadixContextMenu.Content>
            <ContextMenuLabel>
              <Identifier>src_ip</Identifier>
            </ContextMenuLabel>
          </RadixContextMenu.Content>
        </RadixContextMenu.Portal>
      </RadixContextMenu.Root>,
    );
    const label = screen.getByText('src_ip').parentElement;
    expect(label).not.toHaveClass('uppercase');
  });
});

/** The source of every component, tests left out, by path. */
const SOURCES = import.meta.glob<string>(['/src/components/**/*.tsx', '!/src/components/**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * The text of each element whose className sets `uppercase`: from its opening
 * tag to its closing tag. A name inside one must go through `Identifier`.
 */
function uppercaseElements(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/className=(?:"[^"]*|\{`[^`]*)\buppercase\b/g)) {
    const before = source.slice(0, match.index);
    const open = [...before.matchAll(/<([A-Za-z][\w.]*)/g)].pop();
    if (!open) continue;
    const close = source.indexOf(`</${open[1]}>`, match.index);
    if (close !== -1) found.push(source.slice(open.index, close));
  }
  return found;
}

describe('headings that set uppercase (#897)', () => {
  const files = Object.entries(SOURCES);

  it('finds the elements it checks', () => {
    expect(files.flatMap(([, source]) => uppercaseElements(source)).length).toBeGreaterThan(10);
  });

  it('hold no bare <code>: a field, stanza or directive name uses <Identifier>', () => {
    const offenders = files
      .filter(([, source]) => uppercaseElements(source).some((el) => /<code\b/.test(el)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('are not the context menu label, which holds only names', () => {
    expect(uppercaseElements(SOURCES['/src/components/ui/ContextMenu.tsx'] ?? 'missing')).toEqual([]);
  });
});
