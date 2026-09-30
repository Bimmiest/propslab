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

  // The two tests above catch drift between the copies, not a weakening made
  // to both: `'unsafe-inline'` or `https:` added to script-src in the meta and
  // the header passes them. So the sources are pinned exactly (#509). Loosening
  // a directive is a security decision, and it should have to edit this table.
  describe('exact source lists', () => {
    // undefined: the directive is absent, so the browser falls back (to
    // default-src for connect-src) or, for frame-ancestors, cannot honour it.
    const exact: Record<string, string[] | undefined> = {
      'script-src': ["'self'", "'wasm-unsafe-eval'"],
      'default-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'worker-src': ["'self'"],
      // No connect-src: the app makes no cross-origin requests, and
      // default-src 'self' already covers fetch of the wasm and the workers.
      'connect-src': undefined,
    };
    const copies = {
      'header (staticwebapp.config.json)': () => parsePolicy(headers['Content-Security-Policy'] ?? ''),
      'meta (index.html)': () => parsePolicy(metaContent!),
    };
    for (const [copy, policy] of Object.entries(copies)) {
      for (const [directive, sources] of Object.entries(exact)) {
        it(`${copy}: ${directive} is exactly ${sources ? sources.join(' ') : 'absent'}`, () => {
          expect(policy().get(directive)).toEqual(sources);
        });
      }
    }

    // frame-ancestors is ignored in a <meta> policy, so only the header has it.
    it('header: frame-ancestors is exactly none; meta does not carry it', () => {
      expect(copies['header (staticwebapp.config.json)']().get('frame-ancestors')).toEqual(["'none'"]);
      expect(copies['meta (index.html)']().get('frame-ancestors')).toBeUndefined();
    });
  });

  it('adds the header-only and hardening directives', () => {
    const header = parsePolicy(headers['Content-Security-Policy'] ?? '');
    expect(header.get('frame-ancestors')).toEqual(["'none'"]);
    expect(header.get('form-action')).toEqual(["'none'"]);
    expect(header.get('worker-src')).not.toContain('blob:');
    expect(header.get('script-src')).not.toContain("'unsafe-eval'");
  });

  // #458: a DOM-XSS sink added later fails loudly instead of working. The
  // meta policy carries the same directives (checked above).
  it('requires Trusted Types for script sinks, allowing only the policies the build creates', () => {
    const header = parsePolicy(headers['Content-Security-Policy'] ?? '');
    expect(header.get('require-trusted-types-for')).toEqual(["'script'"]);
    const allowed = header.get('trusted-types') ?? [];
    // src/trustedTypes.ts, for Vite's same-origin worker URLs.
    expect(allowed).toContain('default');
    // Monaco's own, created when the editor chunk loads, and its sanitizer's.
    for (const name of [
      'defaultWorkerFactory',
      'editorViewLayer',
      'domLineBreaksComputer',
      'tokenizeToString',
      'dompurify',
    ]) {
      expect(allowed).toContain(name);
    }
    expect(allowed).not.toContain("'none'");
    expect(allowed).not.toContain('*');
  });

  it('enforces Trusted Types in the meta policy as well as the header', () => {
    const meta = parsePolicy(metaContent!);
    expect(meta.get('require-trusted-types-for')).toEqual(["'script'"]);
    expect(meta.get('trusted-types')).toEqual(
      parsePolicy(headers['Content-Security-Policy'] ?? '').get('trusted-types'),
    );
  });

  it('sets COOP and a Permissions-Policy denying unused features', () => {
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    const permissions = headers['Permissions-Policy'] ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(permissions).toMatch(new RegExp(`(^|,\\s*)${feature}=\\(\\)`));
    }
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('sends Strict-Transport-Security with a lifetime of at least a year', () => {
    const hsts = headers['Strict-Transport-Security'] ?? '';
    expect(Number(/(?:^|;\s*)max-age=(\d+)/.exec(hsts)?.[1])).toBeGreaterThanOrEqual(31_536_000);
  });
});
