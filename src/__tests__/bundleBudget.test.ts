import { describe, it, expect } from 'vitest';
import { budgetRows, chunkKey, initialLoadFiles, staleBudgets } from '../../scripts/lib/bundleBudget.mjs';

// The decisions of scripts/check-bundle-size.mjs; reading dist/ and gzipping it
// are the script's own.
describe('chunkKey', () => {
  it('strips the 8-character content hash Vite puts before the extension', () => {
    expect(chunkKey('index-Cj3k_9-A.js')).toBe('index.js');
    expect(chunkKey('monaco-editor-BqX1w2Zy.css')).toBe('monaco-editor.css');
    expect(chunkKey('pcre2-a1B2c3D4.wasm')).toBe('pcre2.wasm');
  });

  it('leaves a name that carries no hash', () => {
    expect(chunkKey('codicon.ttf')).toBe('codicon.ttf');
    // Seven characters is not a hash.
    expect(chunkKey('index-abcdefg.js')).toBe('index-abcdefg.js');
  });

  it('strips only the hash next to the extension, not a dash earlier in the name', () => {
    expect(chunkKey('react-vendor-AbCdEfGh.js')).toBe('react-vendor.js');
  });
});

describe('budgetRows', () => {
  const budgets = { 'index.js': 100, 'react-vendor.js': 70 };

  it('gives each chunk its own budget and marks the ones over it', () => {
    const rows = budgetRows(
      [
        { file: 'index-AbCdEfGh.js', kb: 100.5 },
        { file: 'react-vendor-AbCdEfGh.js', kb: 70 },
      ],
      budgets,
      25,
    );
    expect(rows).toEqual([
      { key: 'index.js', kb: 100.5, budget: 100, over: true },
      // At the budget is within it.
      { key: 'react-vendor.js', kb: 70, budget: 70, over: false },
    ]);
  });

  it('holds a chunk nobody listed to the default, so a new split cannot grow unnoticed', () => {
    const rows = budgetRows(
      [
        { file: 'newsplit-AbCdEfGh.js', kb: 25.1 },
        { file: 'small-AbCdEfGh.js', kb: 3 },
      ],
      budgets,
      25,
    );
    expect(rows.map((r) => [r.key, r.budget, r.over])).toEqual([
      ['newsplit.js', 25, true],
      ['small.js', 25, false],
    ]);
  });
});

describe('staleBudgets', () => {
  it('names a budget whose chunk is gone', () => {
    const rows = budgetRows([{ file: 'index-AbCdEfGh.js', kb: 1 }], { 'index.js': 10, 'gone.js': 10 }, 25);
    expect(staleBudgets({ 'index.js': 10, 'gone.js': 10 }, rows)).toEqual(['gone.js']);
  });

  it('names nothing when every budget has its chunk', () => {
    const rows = budgetRows([{ file: 'index-AbCdEfGh.js', kb: 1 }], { 'index.js': 10 }, 25);
    expect(staleBudgets({ 'index.js': 10 }, rows)).toEqual([]);
  });
});

describe('initialLoadFiles', () => {
  it('lists the entry script, the modulepreloads and the stylesheets, once each', () => {
    const html = `<!doctype html><head>
      <script type="module" src="/assets/index-a1.js"></script>
      <link rel="modulepreload" href="/assets/vendor-b2.js">
      <link rel="modulepreload" href="/assets/vendor-b2.js">
      <link rel="stylesheet" href="/assets/index-c3.css">
    </head>`;
    expect(initialLoadFiles(html)).toEqual(['index-a1.js', 'vendor-b2.js', 'index-c3.css']);
  });

  it('leaves out what is not a script or stylesheet of the build', () => {
    const html = `<head>
      <link rel="icon" href="/assets/favicon-a1.svg">
      <link rel="preload" as="fetch" href="/assets/pcre2-a1.wasm">
      <script src="https://cdn.example/analytics.js"></script>
      <script src="/other/app.js"></script>
      <script type="module" src="/assets/index-a1.js"></script>
    </head>`;
    expect(initialLoadFiles(html)).toEqual(['index-a1.js']);
  });
});
