// @vitest-environment jsdom
// The entry module's one synchronous job before the regex engine loads: put
// the saved theme on <html>, so a dark page does not paint light first.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/regexEngineLoader', () => ({
  // Never settles: the assertion is about what happens before the await.
  loadRegexEngine: () => new Promise(() => {}),
}));

describe('main.tsx', () => {
  beforeEach(() => {
    vi.resetModules();
    document.documentElement.className = '';
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('applies a saved dark theme before the regex engine has loaded', async () => {
    localStorage.setItem('propslab:theme', 'dark');
    await import('../main');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('applies the dark default with nothing saved', async () => {
    localStorage.removeItem('propslab:theme');
    await import('../main');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('leaves a saved light theme light', async () => {
    localStorage.setItem('propslab:theme', 'light');
    await import('../main');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
