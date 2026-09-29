/**
 * The Trusted Types default policy (#458).
 *
 * The CSP enforces `require-trusted-types-for 'script'`, so every string that
 * reaches a DOM script sink must pass through a policy the CSP names. The app
 * itself only reaches one: `new Worker(url)`, which Vite emits for each worker
 * from `new Worker(new URL(…, import.meta.url))` — a pattern that has to stay
 * literal for Vite to bundle the worker, so it cannot be wrapped in a named
 * policy. The default policy, which the browser consults for exactly such
 * plain-string assignments, admits a script URL only from this origin.
 *
 * It defines nothing for HTML or script text, so a string reaching innerHTML,
 * eval-like sinks or a script element's text still throws. Monaco builds its
 * DOM through its own named policies, allowed by name in the CSP.
 */

interface ScriptUrlPolicyFactory {
  createPolicy(name: string, rules: { createScriptURL(url: string): string | null }): unknown;
}

/**
 * Whether a script URL may load: same-origin http(s) only. A blob: URL made
 * here reports this origin too, and is refused like the CSP's worker-src does.
 */
export function isSameOriginScriptUrl(url: string, base: string): boolean {
  try {
    const target = new URL(url, base);
    return /^https?:$/.test(target.protocol) && target.origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** Install the default policy, where the browser supports Trusted Types. */
export function installDefaultTrustedTypesPolicy(): void {
  const factory = (globalThis as { trustedTypes?: ScriptUrlPolicyFactory }).trustedTypes;
  if (!factory) return;
  try {
    factory.createPolicy('default', {
      createScriptURL: (url) => (isSameOriginScriptUrl(url, location.href) ? url : null),
    });
  } catch {
    // Already installed (a hot reload), or refused by a policy without
    // `default`: either way the browser's own checks still apply.
  }
}
