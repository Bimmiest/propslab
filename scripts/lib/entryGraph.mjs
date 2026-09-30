// The walk behind scripts/check-entry-graph.mjs, apart from reading files: the
// static import closure of what dist/index.html loads, and whether it reaches
// the Monaco chunk (#467).

import { dirname, posix } from 'node:path';
import { documentAssets } from './htmlAssets.mjs';

/** The Monaco chunk, which the startup path must never reach. */
export const FORBIDDEN = /(^|\/)monaco-editor-[\w-]+\.(js|css)$/;

// Static imports: `import{a as b}from"./x.js"`, `import"./x.js"`,
// `export{a}from"./x.js"`, `export*from"./x.js"`. `import("./x.js")` has a
// parenthesis before the string and does not match.
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^"'();]*?\bfrom\s*)?["']([^"']+)["']/g;

/**
 * The relative or absolute specifiers a module imports statically. Dynamic
 * `import()` is the lazy path and is deliberately not returned; bare
 * specifiers (packages) are not files of the build and are not either.
 * @param {string} source
 * @returns {string[]}
 */
export function staticImports(source) {
  return [...source.matchAll(STATIC_IMPORT)]
    .map(([, spec]) => spec)
    .filter((s) => s.startsWith('.') || s.startsWith('/'));
}

/**
 * The file a specifier imported from `file` names, as a path from the dist root.
 * @param {string} file the importing file, from the dist root
 * @param {string} spec
 */
export function resolveImport(file, spec) {
  return spec.startsWith('/') ? spec.slice(1) : posix.join(dirname(file), spec);
}

/**
 * Everything the startup path reaches, and what is wrong with it.
 * @param {string} html the document
 * @param {(file: string) => string | null} readSource a file of the build by its path from the dist root, or null when it is not there
 * @returns {{ problems: string[], seen: string[] }}
 */
export function checkEntryGraph(html, readSource) {
  // Every asset the document references, with what refers to it.
  const referenced = documentAssets(html).filter((r) => r.url.startsWith('/assets/'));

  const problems = [];
  for (const { via, url } of referenced) {
    if (FORBIDDEN.test(url)) problems.push(`index.html has a ${via} for ${url}`);
  }

  const seen = new Set();
  const queue = referenced
    .filter((r) => r.url.endsWith('.js'))
    .map((r) => ({ file: r.url.slice(1), from: 'index.html' }));
  while (queue.length > 0) {
    const { file, from } = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readSource(file);
    if (source === null) {
      problems.push(`${from} refers to ${file}, which is not in the build`);
      continue;
    }
    for (const spec of staticImports(source)) {
      const target = resolveImport(file, spec);
      if (FORBIDDEN.test(target)) problems.push(`${file} statically imports ${target}`);
      else if (target.endsWith('.js')) queue.push({ file: target, from: file });
    }
  }
  return { problems, seen: [...seen].sort() };
}
