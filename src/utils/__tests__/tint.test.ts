// An alpha byte appended to a var() reference is not a colour, so every
// translucent fill goes through tint(), which accepts a var() as well as a hex.
import { describe, it, expect } from 'vitest';
import { tint } from '../tint';

describe('tint', () => {
  it('mixes a CSS variable with transparent', () => {
    expect(tint('var(--color-warning)', 13)).toBe('color-mix(in srgb, var(--color-warning) 13%, transparent)');
  });

  it('mixes a hex colour the same way', () => {
    expect(tint('#1d4ed8', 25)).toBe('color-mix(in srgb, #1d4ed8 25%, transparent)');
  });
});
