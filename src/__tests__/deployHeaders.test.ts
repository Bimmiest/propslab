import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import config from '../../public/staticwebapp.config.json';

// The <meta> CSP in index.html covers the document only; each worker takes its
// policy from its own response headers, which on Azure Static Web Apps come
// from staticwebapp.config.json. The two copies must not drift: a directive
// missing from the header leaves the workers unguarded, and a source list that
// differs is enforced as the intersection, blocking something for no visible
// reason.

const headers: Record<string, string> = config.globalHeaders;

function parsePolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

const metaContent = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];

describe('deployed security headers', () => {
  it('index.html carries a meta CSP', () => {
    expect(metaContent).toBeTruthy();
  });

  it('sends every directive of the meta CSP, with the same sources, as a header', () => {
    const meta = parsePolicy(metaContent!);
    const header = parsePolicy(headers['Content-Security-Policy'] ?? '');
    for (const [name, sources] of meta) {
      expect(header.get(name), name).toEqual(sources);
    }
  });

  it('adds the header-only and hardening directives', () => {
    const header = parsePolicy(headers['Content-Security-Policy'] ?? '');
    expect(header.get('frame-ancestors')).toEqual(["'none'"]);
    expect(header.get('form-action')).toEqual(["'none'"]);
    expect(header.get('worker-src')).not.toContain('blob:');
    expect(header.get('script-src')).not.toContain("'unsafe-eval'");
  });

  it('sets COOP and a Permissions-Policy denying unused features', () => {
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    const permissions = headers['Permissions-Policy'] ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(permissions).toMatch(new RegExp(`(^|,\\s*)${feature}=\\(\\)`));
    }
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
});
