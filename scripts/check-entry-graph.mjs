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
import { join } from 'node:path';
import { checkEntryGraph } from './lib/entryGraph.mjs';

const distDir = process.argv[2] ?? 'dist';

let html;
try {
  html = readFileSync(join(distDir, 'index.html'), 'utf8');
} catch {
  console.error(`No build output at ${distDir}/index.html — run \`npm run build\` first.`);
  process.exit(1);
}

const { problems, seen } = checkEntryGraph(html, (file) => {
  try {
    return readFileSync(join(distDir, file), 'utf8');
  } catch {
    return null;
  }
});

console.log(`Checked ${seen.length} startup file(s) reachable from dist/index.html:`);
for (const file of seen) console.log(`  ${file}`);

if (problems.length > 0) {
  console.error('\nThe startup path reaches the Monaco chunk:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nThe editors must load lazily. Check the codeSplitting groups in vite.config.ts.');
  process.exit(1);
}
console.log('ok    the entry graph does not reach monaco-editor-*');
