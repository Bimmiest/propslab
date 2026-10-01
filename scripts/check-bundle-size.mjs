// ---------------------------------------------------------------------------
// check-bundle-size.mjs
//
// Fails when a built chunk's gzip size exceeds its budget. Vite prints sizes on
// every build, and a warning printed on every build is read by no one.
// Headroom over the sizes measured when the budgets were set is 8–15% for the
// app's own chunks, so ordinary growth fits and a new dependency or a lost code
// split does not. The two chunks that are nearly all monaco-editor
// (monaco-editor.js and editor.worker.js) have only ~3–5%: they change when
// monaco-editor is upgraded, and that is a change worth a deliberate look. When
// a budget trips for a good reason, raise it here in the same change and say
// why in the commit.
//
// Per-chunk budgets say nothing about which chunks load at startup, so there
// is also an initial-load budget: the gzip sum of every file dist/index.html
// pulls in (the entry script, its modulepreloads and its stylesheets). #467
// was a build in which each chunk stayed within budget while the entry
// preloaded the whole Monaco chunk. That the graph is right is checked by
// check-entry-graph.mjs; this sum catches it growing.
//
// Chunks are matched by name with the content hash stripped. A chunk with no
// budget of its own falls under DEFAULT_KB, so a new split cannot grow
// unnoticed just because nobody listed it.
//
// Usage: node scripts/check-bundle-size.mjs [distDir]   (after `npm run build`)
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { budgetRows, initialLoadFiles, staleBudgets } from './lib/bundleBudget.mjs';

/**
 * Budgets in kB (1000 bytes, as Vite reports) of gzip output, keyed by
 * `<chunk name>.<ext>`. Sizes measured by this script at level-6 gzip, which
 * reads ~1% under Vite's own figures.
 */
const BUDGETS_KB = {
  // 853.8 kB; 903 kB while MonacoEditor.tsx imported all of editor.all.
  'monaco-editor.js': 880,
  'monaco-editor.css': 26, // 23.2 (monaco-editor 0.57's stylesheet is larger than 0.55's 18.8)
  // 143.2 kB; 160 kB before the editors, dictionary and scaffold split out.
  'index.js': 165,
  'index.css': 9.5, // 8.4
  'react-vendor.js': 77, // 67.5
  'pipeline.js': 33, // 29.5
  'editorRuntime.js': 11, // 9.7
  // Workers: off the startup path, but each is a whole download of its own.
  // 70.0 kB; 62.9 kB before the fidelity answers (#442–#451, #522) added the
  // stanza-pattern tokenizer, eval operand typing and the CSV row rejoining.
  'pipelineWorker.js': 77,
  'editor.worker.js': 97, // 92.8
  // PCRE2, the regex engine every user pattern runs on. The page and each
  // worker fetch and compile it for themselves.
  'pcre2.wasm': 95, // 83.5
  // Monaco's icon font. Fetched only when an editor mounts, but it is 150 kB
  // raw, and a font swap or an added icon set would double it unnoticed.
  'codicon.ttf': 85, // 75.4
};
const DEFAULT_KB = 25;

// What a first visit downloads before main.tsx runs: the sum of the gzip sizes
// of everything dist/index.html references. 231.4 kB when set (entry 148.5,
// react-vendor 67.5, directiveValues 6.5, index.css 8.5, runtime 0.4).
const INITIAL_LOAD_BUDGET_KB = 260;

const dir = join(process.argv[2] ?? 'dist', 'assets');
let files;
try {
  files = readdirSync(dir).filter((f) => /\.(js|css|wasm|ttf)$/.test(f));
} catch {
  console.error(`No build output at ${dir} — run \`npm run build\` first.`);
  process.exit(1);
}

const rows = budgetRows(
  files.map((file) => ({ file, kb: gzipSync(readFileSync(join(dir, file))).length / 1000 })),
  BUDGETS_KB,
  DEFAULT_KB,
);

// The initial-load set, straight from the HTML: `src` of the entry script,
// `href` of each modulepreload and stylesheet.
let html;
try {
  html = readFileSync(join(dirname(dir), 'index.html'), 'utf8');
} catch {
  console.error(`No index.html next to ${dir} — run \`npm run build\` first.`);
  process.exit(1);
}
const initialFiles = initialLoadFiles(html);
const initialKb = initialFiles.reduce((sum, f) => sum + gzipSync(readFileSync(join(dir, f))).length / 1000, 0);
const initialOver = initialKb > INITIAL_LOAD_BUDGET_KB;

// A budget whose chunk does not exist is stale: renamed or merged away, and
// guarding nothing.
const missing = staleBudgets(BUDGETS_KB, rows);

for (const r of rows.sort((a, b) => b.kb - a.kb)) {
  const mark = r.over ? 'OVER' : 'ok';
  console.log(`${mark.padEnd(4)}  ${r.key.padEnd(28)} ${r.kb.toFixed(1).padStart(7)} kB / ${r.budget} kB`);
}
for (const key of missing) console.log(`MISSING  ${key} has a budget but no chunk`);
console.log(
  `${(initialOver ? 'OVER' : 'ok').padEnd(4)}  ${'initial load'.padEnd(28)} ${initialKb.toFixed(1).padStart(7)} kB / ${INITIAL_LOAD_BUDGET_KB} kB  (${initialFiles.length} files)`,
);

const over = rows.filter((r) => r.over);
if (over.length > 0 || missing.length > 0 || initialOver) {
  console.error(
    `\n${over.length} chunk(s) over budget, ${missing.length} budget(s) without a chunk, initial load ${initialOver ? 'over' : 'within'} budget.`,
  );
  process.exit(1);
}
