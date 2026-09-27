// ---------------------------------------------------------------------------
// check-bundle-size.mjs
//
// Fails when a built chunk's gzip size exceeds its budget (#375).
//
// Monaco's chunk sat at 913 KB gzip for months because nothing measured it:
// Vite prints sizes on every build, and a warning printed on every build is
// read by no one. Budgets are ~10–15% over the sizes measured when they were
// set, so ordinary growth fits and a new dependency or a lost code split does
// not. When a budget trips for a good reason, raise it here in the same change
// and say why in the commit.
//
// Chunks are matched by name with the content hash stripped. A chunk with no
// budget of its own falls under DEFAULT_KB, so a new split cannot grow
// unnoticed just because nobody listed it.
//
// Usage: node scripts/check-bundle-size.mjs [distDir]   (after `npm run build`)
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Budgets in kB (1000 bytes, as Vite reports) of gzip output, keyed by
 * `<chunk name>.<ext>`. Sizes measured by this script at level-6 gzip, which
 * reads ~1% under Vite's own figures.
 */
const BUDGETS_KB = {
  // 792 kB; 903 kB while MonacoEditor.tsx imported all of editor.all.
  'monaco-editor.js': 880,
  'monaco-editor.css': 21, // 18.8
  // 146 kB; 160 kB before the editors, dictionary and scaffold split out.
  'index.js': 165,
  'index.css': 9.5, // 8.4
  'react-vendor.js': 77, // 67.5
  'pipeline.js': 33, // 28.6
  'editorRuntime.js': 11, // 9.5
  // Workers: off the startup path, but each is a whole download of its own.
  'pipelineWorker.js': 70, // 61.4
  'editor.worker.js': 97, // 85.9
};
const DEFAULT_KB = 25;

const dir = join(process.argv[2] ?? 'dist', 'assets');
let files;
try {
  files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
} catch {
  console.error(`No build output at ${dir} — run \`npm run build\` first.`);
  process.exit(1);
}

const rows = files.map((file) => {
  // `name-<hash>.ext`; Vite's hashes are 8 url-safe base64 characters.
  const key = file.replace(/-[\w-]{8}(\.\w+)$/, '$1');
  const kb = gzipSync(readFileSync(join(dir, file))).length / 1000;
  const budget = BUDGETS_KB[key] ?? DEFAULT_KB;
  return { key, kb, budget, over: kb > budget };
});

// A budget whose chunk no longer exists is stale: renamed or merged away, and
// no longer guarding anything.
const missing = Object.keys(BUDGETS_KB).filter((key) => !rows.some((r) => r.key === key));

for (const r of rows.sort((a, b) => b.kb - a.kb)) {
  const mark = r.over ? 'OVER' : 'ok';
  console.log(`${mark.padEnd(4)}  ${r.key.padEnd(28)} ${r.kb.toFixed(1).padStart(7)} kB / ${r.budget} kB`);
}
for (const key of missing) console.log(`MISSING  ${key} has a budget but no chunk`);

const over = rows.filter((r) => r.over);
if (over.length > 0 || missing.length > 0) {
  console.error(`\n${over.length} chunk(s) over budget, ${missing.length} budget(s) without a chunk.`);
  process.exit(1);
}
