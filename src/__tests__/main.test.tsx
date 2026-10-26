// @vitest-environment jsdom
// The entry module's synchronous jobs before the regex engine loads: install
// the Trusted Types default policy, and put the saved theme on <html>, so a
// dark page does not paint light first.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// What the Trusted Types factory had been asked to create at the moment `App`
// was first evaluated (see 'installs the Trusted Types policy before App').
const seen = vi.hoisted(() => ({ policiesWhenAppLoaded: undefined as string[] | undefined }));

const mockApp = vi.hoisted(() => () => {
  const factory = (globalThis as { trustedTypes?: { createPolicy: { mock: { calls: string[][] } } } }).trustedTypes;
  seen.policiesWhenAppLoaded = factory?.createPolicy.mock.calls.map(([name]) => String(name));
  return { default: () => null };
});

vi.mock('../App.tsx', mockApp);

vi.mock('../workers/regexEngineLoader', () => ({
  // Never settles: the assertion is about what happens before the await.
  loadRegexEngine: () => new Promise(() => {}),
}));

describe('main.tsx', () => {
  beforeEach(() => {
    seen.policiesWhenAppLoaded = undefined;
    vi.resetModules();
    // resetModules clears the module cache but not the mock registry, so
    // without this the factory above runs only for the first test that
    // imports main, and a shuffled order leaves the policy test reading
    // nothing (#587).
    vi.doMock('../App.tsx', mockApp);
    document.documentElement.className = '';
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // #509: the CSP requires Trusted Types, and the default policy is what lets a
  // worker URL through. A call in main.tsx's body ran after every import had
  // evaluated; the install now lives in a module main.tsx imports first, so
  // reordering the imports (or moving the call back below them) fails here.
  it('installs the Trusted Types policy before App is imported', async () => {
    const createPolicy = vi.fn();
    vi.stubGlobal('trustedTypes', { createPolicy });
    await import('../main');
    expect(createPolicy).toHaveBeenCalledWith('default', expect.any(Object));
    expect(seen.policiesWhenAppLoaded).toEqual(['default']);
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
