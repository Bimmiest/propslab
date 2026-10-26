// No text under 12 px (#564). Every small size in the app was a badge, count,
// label or error message, so the floor holds for all of them: text-xs is the
// smallest size a component may use. Read through import.meta.glob, as
// docs.test.ts does, because the app's tsconfig has no Node types.
import { describe, it, expect } from 'vitest';

const sources = import.meta.glob<string>(['/src/**/*.tsx', '!/src/**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Each arbitrary text size under 12 px in `source`, such as `text-[10px]` or `text-[0.6rem]`. */
function sizesUnder12px(source: string): string[] {
  return [...source.matchAll(/text-\[(\d*\.?\d+)(px|rem)\]/g)]
    .filter(([, value = '', unit]) => Number(value) * (unit === 'rem' ? 16 : 1) < 12)
    .map(([match]) => match);
}

describe('text size floor (#564)', () => {
  it('finds the sizes it is looking for', () => {
    expect(sizesUnder12px('a text-[9px] b text-[11px] text-[0.6rem] text-[12px] text-[0.75rem] text-xs')).toEqual([
      'text-[9px]',
      'text-[11px]',
      'text-[0.6rem]',
    ]);
  });

  it('reads the components', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  it('no component sets text under 12 px', () => {
    const offenders = Object.entries(sources).flatMap(([file, source]) =>
      sizesUnder12px(source).map((size) => `${file}: ${size}`),
    );
    expect(offenders).toEqual([]);
  });
});
