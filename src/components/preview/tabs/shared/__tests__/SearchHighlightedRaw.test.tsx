// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SearchHighlightedRaw } from '../SearchHighlightedRaw';

const marks = (container: HTMLElement) => [...container.querySelectorAll('mark')].map((m) => m.textContent);

describe('SearchHighlightedRaw', () => {
  it('marks every case-insensitive match, as written in the event', () => {
    const { container } = render(<SearchHighlightedRaw raw="Error then ERROR" search="error" />);
    expect(marks(container)).toEqual(['Error', 'ERROR']);
  });

  it('marks the right text after a character whose lower case is longer (#624)', () => {
    // `İ`.toLowerCase() is two code units, so offsets read off the lower-cased
    // line were one off for each `İ` before the match.
    const { container } = render(<SearchHighlightedRaw raw="İİstanbul error here" search="error" />);
    expect(marks(container)).toEqual(['error']);
    expect(container.textContent).toBe('İİstanbul error here');
  });

  it('treats the search as text, not a pattern', () => {
    const { container } = render(<SearchHighlightedRaw raw="a.b axb (c)" search="a.b" />);
    expect(marks(container)).toEqual(['a.b']);
    const { container: parens } = render(<SearchHighlightedRaw raw="a.b axb (c)" search="(c)" />);
    expect(marks(parens)).toEqual(['(c)']);
  });
});
