#!/usr/bin/env node
// Reads a comma-separated list of changed files and prints it again without
// the files whose change against the base ref is formatting or comments only.
// Used by mutation.yml, which mutates only the engine files a PR changes: a
// reformat, or a comment edit across many files, would otherwise re-mutate
// them all for a change that cannot move the score.
//
// Usage: node scripts/drop-format-only.mjs <base-ref> <file,file,...>
// Each dropped file is named on stderr, as a Markdown line for the job summary.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isCommentOnly, isFormattingOnly } from './lib/formatOnly.mjs';

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
  const after = readFileSync(file, 'utf8');
  if (await isFormattingOnly(file, before, after)) {
    console.error(`Formatting-only change, not mutated: \`${file}\``);
  } else if (isCommentOnly(file, before, after)) {
    console.error(`Comment-only change, not mutated: \`${file}\``);
  } else {
    kept.push(file);
  }
}
console.log(kept.join(','));
