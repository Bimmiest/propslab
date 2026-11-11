// ---------------------------------------------------------------------------
// mutation-shard.mjs
//
// The files that one shard of the weekly mutation run mutates (#851), as a
// comma list for `stryker run --mutate`. The files are those that
// stryker.config.mjs's `mutate` selects, so the scope is written in one place.
// The shard number counts from 1.
//
//   node scripts/mutation-shard.mjs <count> <shard>
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MUTATE_GLOBS, selectMutated } from './lib/mutationTargets.mjs';
import { assignShards } from './lib/mutationShards.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const count = Number(process.argv[2]);
  const shard = Number(process.argv[3]);
  if (!Number.isInteger(count) || !Number.isInteger(shard) || shard < 1 || shard > count) {
    console.error('Usage: node scripts/mutation-shard.mjs <count> <shard>, with 1 <= shard <= count');
    process.exit(2);
  }
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const files = selectMutated(tracked, MUTATE_GLOBS).map((path) => ({ path, size: statSync(path).size }));
  const paths = assignShards(files, count)[shard - 1] ?? [];
  // An empty --mutate would make Stryker mutate its whole `mutate` list.
  if (paths.length === 0) {
    console.error(`Shard ${shard} of ${count} has no files: there are more shards than files to mutate.`);
    process.exit(1);
  }
  console.log(paths.join(','));
}
