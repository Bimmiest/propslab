// The default Trusted Types policy lets only same-origin script URLs through (#458).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installDefaultTrustedTypesPolicy, isSameOriginScriptUrl } from '../trustedTypes';

const BASE = 'https://propslab.example/index.html';

describe('isSameOriginScriptUrl', () => {
  it('admits this origin, absolute or relative', () => {
    expect(isSameOriginScriptUrl('https://propslab.example/assets/pipelineWorker-abc.js', BASE)).toBe(true);
    expect(isSameOriginScriptUrl('/assets/regexMatchWorker-abc.js', BASE)).toBe(true);
    expect(isSameOriginScriptUrl('assets/x.js', BASE)).toBe(true);
  });

  it('refuses another origin, another scheme or port, and blob: and data: URLs', () => {
    expect(isSameOriginScriptUrl('https://evil.example/x.js', BASE)).toBe(false);
    expect(isSameOriginScriptUrl('http://propslab.example/x.js', BASE)).toBe(false);
    expect(isSameOriginScriptUrl('https://propslab.example:8443/x.js', BASE)).toBe(false);
    expect(isSameOriginScriptUrl('//evil.example/x.js', BASE)).toBe(false);
    expect(isSameOriginScriptUrl('data:text/javascript,alert(1)', BASE)).toBe(false);
    expect(isSameOriginScriptUrl('blob:https://propslab.example/0b1c', BASE)).toBe(false);
    expect(isSameOriginScriptUrl('javascript:alert(1)', BASE)).toBe(false);
  });
});

describe('installDefaultTrustedTypesPolicy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing where the browser has no Trusted Types', () => {
    vi.stubGlobal('trustedTypes', undefined);
    expect(() => installDefaultTrustedTypesPolicy()).not.toThrow();
  });

  it('creates a default policy with a script-URL rule and nothing for HTML or script text', () => {
    const createPolicy = vi.fn();
    vi.stubGlobal('trustedTypes', { createPolicy });
    vi.stubGlobal('location', new URL(BASE));
    installDefaultTrustedTypesPolicy();
    expect(createPolicy).toHaveBeenCalledTimes(1);
    const [name, rules] = createPolicy.mock.calls[0] as [string, Record<string, (s: string) => string | null>];
    expect(name).toBe('default');
    expect(Object.keys(rules)).toEqual(['createScriptURL']);
    expect(rules.createScriptURL!('/assets/w.js')).toBe('/assets/w.js');
    expect(rules.createScriptURL!('https://evil.example/w.js')).toBeNull();
  });

  it('survives a refusal (a policy already installed, or not allowed)', () => {
    vi.stubGlobal('trustedTypes', { createPolicy: () => { throw new TypeError('refused'); } });
    expect(() => installDefaultTrustedTypesPolicy()).not.toThrow();
  });
});
