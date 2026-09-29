// Documentation stays in step with the tree (#519). Files are read through
// Vite's import.meta.glob rather than node:fs because the app's tsconfig has
// no Node types; the existence set is the glob's key list, nothing is loaded.
import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';

const markdown = import.meta.glob<string>(
  ['/README.md', '/CONTRIBUTING.md', '/SECURITY.md', '/docs/**/*.md'],
  { query: '?raw', import: 'default', eager: true },
);
const existing = Object.keys(
  import.meta.glob(
    ['/*', '/.nvmrc', '/.gitignore', '/docs/**', '/src/**', '/packages/**', '/scripts/**', '/.github/**', '/e2e/**', '/public/**'],
    { query: '?url' },
  ),
);
const readme = markdown['/README.md'] ?? '';

function buildBlockScripts(text: string): Set<string> {
  const start = text.indexOf('## Build');
  const section = start === -1 ? '' : text.slice(start, text.indexOf('\n## ', start + 1));
  const found = new Set<string>();
  const run = /npm\s+run\s+([a-z0-9:.-]+)/g;
  let match;
  while ((match = run.exec(section)) !== null) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  if (/npm\s+test(?:\s|#|$)/.test(section)) found.add('test');
  return found;
}

function exists(path: string): boolean {
  const abs = path.startsWith('/') ? path : `/${path}`;
  return existing.includes(abs) || existing.some((f) => f.startsWith(`${abs.replace(/\/$/, '')}/`));
}

describe('Documentation', () => {
  const scripts = Object.keys(pkg.scripts);
  const documented = buildBlockScripts(readme);

  it('every package.json script appears in the README Build block', () => {
    const missing = scripts.filter((s) => !documented.has(s));
    expect(missing, `Scripts missing from README: ${missing.join(', ')}`).toEqual([]);
  });

  it('every README Build block script exists in package.json', () => {
    const stale = [...documented].filter((s) => !scripts.includes(s));
    expect(stale, `README lists scripts package.json lacks: ${stale.join(', ')}`).toEqual([]);
  });

  for (const [file, text] of Object.entries(markdown)) {
    it(`relative links in ${file} resolve`, () => {
      const dir = file.slice(0, file.lastIndexOf('/'));
      const links = [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
        .map((m) => m[1] ?? '')
        .filter((l) => l !== '' && !/^(https?:|mailto:|#)/.test(l) && !/NNNN/.test(l))
        .map((l) => l.replace(/[#?].*$/, ''))
        .filter((l) => l !== '');
      const broken = links.filter((l) => !exists(l.startsWith('/') ? l : `${dir}/${l}`.replace(/\/\.\//g, '/').replace(/\/[^/]+\/\.\.\//g, '/')));
      expect(broken, `Broken links in ${file}: ${broken.join(', ')}`).toEqual([]);
    });
  }
});
