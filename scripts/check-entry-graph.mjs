// ---------------------------------------------------------------------------
// check-entry-graph.mjs
//
// Fails when the startup path reaches the Monaco chunk. The editors are meant
// to load lazily (LazyEditors.tsx): the entry chunk neither contains nor waits
// for Monaco. A code-splitting group that swallowed Vite's preload helper broke
// that once (#467) — the entry began `import … from "./monaco-editor-*.js"` and
// index.html preloaded the 3.4 MB chunk and its stylesheet — while every chunk
// stayed inside its own size budget, so nothing else noticed.
//
// Checked, from dist/index.html:
//   - no <script>, modulepreload or stylesheet refers to a monaco-editor-* file;
//   - no file in the STATIC import closure of the entry script and the
//     modulepreloads imports one. Dynamic `import()` is the lazy path and is
//     deliberately not followed.
//
// Usage: node scripts/check-entry-graph.mjs [distDir]   (after `npm run build`)
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { documentAssets } from './lib/htmlAssets.mjs';

const distDir = process.argv[2] ?? 'dist';
const FORBIDDEN = /(^|\/)monaco-editor-[\w-]+\.(js|css)$/;

let html;
try {
  html = readFileSync(join(distDir, 'index.html'), 'utf8');
} catch {
  console.error(`No build output at ${distDir}/index.html — run \`npm run build\` first.`);
  process.exit(1);
}

// Every asset the document references, with what refers to it.
const referenced = documentAssets(html).filter((r) => r.url.startsWith('/assets/'));

const problems = [];
for (const { via, url } of referenced) {
  if (FORBIDDEN.test(url)) problems.push(`index.html has a ${via} for ${url}`);
}

// Static imports: `import{a as b}from"./x.js"`, `import"./x.js"`,
// `export{a}from"./x.js"`, `export*from"./x.js"`. `import("./x.js")` has a
// parenthesis before the string and does not match.
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^"'();]*?\bfrom\s*)?["']([^"']+)["']/g;

const seen = new Set();
const queue = referenced.filter((r) => r.url.endsWith('.js')).map((r) => ({ file: r.url.slice(1), from: 'index.html' }));
while (queue.length > 0) {
  const { file, from } = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  let source;
  try {
    source = readFileSync(join(distDir, file), 'utf8');
  } catch {
    problems.push(`${from} refers to ${file}, which is not in the build`);
    continue;
  }
  for (const [, spec] of source.matchAll(STATIC_IMPORT)) {
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const target = spec.startsWith('/') ? spec.slice(1) : posix.join(dirname(file), spec);
    if (FORBIDDEN.test(target)) problems.push(`${file} statically imports ${target}`);
    else if (target.endsWith('.js')) queue.push({ file: target, from: file });
  }
}

console.log(`Checked ${seen.size} startup file(s) reachable from dist/index.html:`);
for (const file of [...seen].sort()) console.log(`  ${file}`);

if (problems.length > 0) {
  console.error('\nThe startup path reaches the Monaco chunk:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nThe editors must load lazily. Check the codeSplitting groups in vite.config.ts.');
  process.exit(1);
}
console.log('ok    the entry graph does not reach monaco-editor-*');
