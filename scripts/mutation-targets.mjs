// ---------------------------------------------------------------------------
// mutation-targets.mjs
//
// The files a pull request's mutation run mutates (#571), as two lines for
// $GITHUB_OUTPUT:
//
//   changed=<the mutable source files the PR added or modified>
//   tested=<the mutable source files a changed test file imports>
//
// Both are filtered by stryker.config.mjs's own `mutate` globs, so the scope
// is written in one place. Renames are off, so a renamed and edited file is a
// new file here rather than a status that no filter keeps. `changed` still
// goes through drop-format-only.mjs; `tested` does not, because those files did
// not change.
//
//   node scripts/mutation-targets.mjs <base-ref>
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importedSources, isTestFile, MUTATE_GLOBS, selectMutated } from './lib/mutationTargets.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error('Usage: node scripts/mutation-targets.mjs <base-ref>');
    process.exit(2);
  }
  const diff = execFileSync('git', ['diff', '--name-only', '--no-renames', '--diff-filter=AM', `${baseRef}...HEAD`], {
    encoding: 'utf8',
  });
  const files = diff.split('\n').filter(Boolean);
  const changed = selectMutated(files, MUTATE_GLOBS);
  const imported = files
    .filter((f) => isTestFile(f) && existsSync(f))
    .flatMap((f) => importedSources(f, readFileSync(f, 'utf8'), existsSync));
  const tested = selectMutated([...new Set(imported)], MUTATE_GLOBS).filter((f) => !changed.includes(f));
  console.log(`changed=${changed.join(',')}`);
  console.log(`tested=${tested.join(',')}`);
}
