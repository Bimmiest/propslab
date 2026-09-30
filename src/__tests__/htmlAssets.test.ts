import { describe, it, expect } from 'vitest';
import { documentAssets } from '../../scripts/lib/htmlAssets.mjs';

// The CI gates (check-entry-graph.mjs, check-bundle-size.mjs) read the startup
// assets through this; a reference it misses is one the gates never check.
describe('documentAssets', () => {
  it('reads what Vite emits', () => {
    const html = `<!doctype html><head>
      <script type="module" crossorigin src="/assets/index-a1.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/vendor-b2.js">
      <link rel="stylesheet" crossorigin href="/assets/index-c3.css">
    </head><body></body>`;
    expect(documentAssets(html)).toEqual([
      { via: 'script', url: '/assets/index-a1.js' },
      { via: 'modulepreload', url: '/assets/vendor-b2.js' },
      { via: 'stylesheet', url: '/assets/index-c3.css' },
    ]);
  });

  it('reads the tags a regex would miss', () => {
    const html = `<SCRIPT SRC='/assets/upper.js'></SCRIPT>
      <link data-x="a>b" rel=modulepreload href=/assets/unquoted.js>
      <script>const s = "<script src='/assets/inline.js'>";</script>`;
    expect(documentAssets(html)).toEqual([
      { via: 'script', url: '/assets/upper.js' },
      { via: 'modulepreload', url: '/assets/unquoted.js' },
    ]);
  });
});
