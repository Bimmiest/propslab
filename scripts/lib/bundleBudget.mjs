// The decisions behind scripts/check-bundle-size.mjs, apart from reading the
// build: which budget a chunk falls under, which chunks are over it, which
// budgets guard nothing, and which files the startup path downloads.

import { documentAssets } from './htmlAssets.mjs';

/**
 * A chunk's budget key: its file name with the content hash stripped.
 * `name-<hash>.ext`; Vite's hashes are 8 url-safe base64 characters.
 * @param {string} file
 */
export function chunkKey(file) {
  return file.replace(/-[\w-]{8}(\.\w+)$/, '$1');
}

/**
 * Each file with its budget and whether it is over. A chunk with no budget of
 * its own falls under `defaultKb`, so a new split cannot grow unnoticed just
 * because nobody listed it.
 * @param {{ file: string, kb: number }[]} files
 * @param {Record<string, number>} budgets
 * @param {number} defaultKb
 */
export function budgetRows(files, budgets, defaultKb) {
  return files.map(({ file, kb }) => {
    const key = chunkKey(file);
    const budget = budgets[key] ?? defaultKb;
    return { key, kb, budget, over: kb > budget };
  });
}

/**
 * Budgets whose chunk does not exist: renamed or merged away, and guarding
 * nothing.
 * @param {Record<string, number>} budgets
 * @param {{ key: string }[]} rows
 */
export function staleBudgets(budgets, rows) {
  return Object.keys(budgets).filter((key) => !rows.some((r) => r.key === key));
}

/**
 * The files a first visit downloads before the app runs, from the HTML: the
 * `src` of the entry script and the `href` of each modulepreload and
 * stylesheet, under /assets/, once each, scripts and styles only.
 * @param {string} html
 * @returns {string[]} file names relative to the assets directory
 */
export function initialLoadFiles(html) {
  return [
    ...new Set(
      documentAssets(html)
        .filter((r) => r.url.startsWith('/assets/'))
        .map((r) => r.url.slice('/assets/'.length)),
    ),
  ].filter((f) => /\.(js|css)$/.test(f));
}
