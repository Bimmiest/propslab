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
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCommentOnly } from './lib/formatOnly.mjs';

/**
 * The command, given its arguments and what it reads and writes through: `show`
 * is a file's text at the base ref (null when it is not there), `read` its text
 * now, `out` and `err` stdout and stderr. Returns the exit code.
 */
export async function run([baseRef, list = ''], { show, read, out, err }) {
  if (!baseRef) {
    err('Usage: node scripts/drop-format-only.mjs <base-ref> <file,file,...>');
    return 2;
  }
  const kept = [];
  for (const file of list.split(',').filter(Boolean)) {
    const before = show(baseRef, file);
    if (before === null) {
      kept.push(file); // new on this branch
      continue;
    }
    const after = read(file);
    if (isCommentOnly(file, before, after)) {
      err(`Formatting or comment change only, not mutated: \`${file}\``);
    } else {
      kept.push(file);
    }
  }
  out(kept.join(','));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2), {
    show: (baseRef, file) => {
      try {
        return execFileSync('git', ['show', `${baseRef}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      } catch {
        return null;
      }
    },
    read: (file) => readFileSync(file, 'utf8'),
    out: console.log,
    err: console.error,
  });
}
