// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { FieldSplitLayout } from '../FieldSplitLayout';

const KEY = 'test-split-layout';

// JSON.parse succeeds for plenty of values that are not a Layout, so the
// stored value is validated before it reaches the panel group.
describe('FieldSplitLayout — persisted layout is shape-checked (#35.3)', () => {
  beforeEach(() => localStorage.clear());

  const renderWith = (saved: string) => {
    localStorage.setItem(KEY, saved);
    return render(
      <FieldSplitLayout storageKey={KEY} collapsed={false} sidebar={<div>side</div>}>
        <div>body</div>
      </FieldSplitLayout>,
    );
  };

  it.each([
    ['null', 'null'],
    ['an array', '[1,2]'],
    ['wrong value types', '{"events":"x","sidebar":"y"}'],
    ['missing keys', '{"foo":1}'],
    ['malformed json', '{not json'],
  ])('falls back to the default for %s', (_label, saved) => {
    const { getByText } = renderWith(saved);
    expect(getByText('body')).toBeInTheDocument();
  });

  it('uses a well-formed saved layout', () => {
    const { getByText } = renderWith('{"events":70,"sidebar":30}');
    expect(getByText('body')).toBeInTheDocument();
    expect(getByText('side')).toBeInTheDocument();
  });
});
