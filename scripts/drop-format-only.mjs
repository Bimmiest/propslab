#!/usr/bin/env node
// Reads a comma-separated list of changed files and prints it again without
// the files whose change against the base ref is formatting only. Used by
// mutation.yml, which mutates only the engine files a PR changes: a
// reformat touches every one of them and would otherwise re-mutate the whole
// engine for a change that cannot move the score.
//
// Usage: node scripts/drop-format-only.mjs <base-ref> <file,file,...>
// Each dropped file is named on stderr, as a Markdown line for the job summary.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isFormattingOnly } from './lib/formatOnly.mjs';

const [baseRef, list = ''] = process.argv.slice(2);
if (!baseRef) {
  console.error('Usage: node scripts/drop-format-only.mjs <base-ref> <file,file,...>');
  process.exit(2);
}

const kept = [];
for (const file of list.split(',').filter(Boolean)) {
  let before;
  try {
    before = execFileSync('git', ['show', `${baseRef}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    kept.push(file); // new on this branch
    continue;
  }
  if (await isFormattingOnly(file, before, readFileSync(file, 'utf8'))) {
    console.error(`Formatting-only change, not mutated: \`${file}\``);
  } else {
    kept.push(file);
  }
}
console.log(kept.join(','));
