// ---------------------------------------------------------------------------
// check-mutation-score.mjs
//
// The floor for the weekly mutation run in shards (#851). Each shard runs with
// MUTATION_SHARD=1, so Stryker applies no floor to one shard alone. This reads
// the report of each shard, scores their files together, and fails when the
// combined score is below `thresholds.break` in stryker.config.mjs. It writes a
// Markdown table for the job summary to stdout.
//
// <dir> has one directory for each shard, as download-artifact gives them:
// mutation-report-<shard>-of-<count>/mutation.json.
//
//   node scripts/check-mutation-score.mjs <dir>
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import stryker from '../stryker.config.mjs';
import { mergeFiles, score, shardCount } from './lib/mutationShards.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.argv[2] ?? 'reports/shards';
  const floor = stryker.thresholds?.break;
  if (typeof floor !== 'number') {
    console.error('stryker.config.mjs gives no number for thresholds.break. Run this without MUTATION_SHARD set.');
    process.exit(2);
  }
  const names = readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  let count = 0;
  try {
    count = shardCount(names);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const reports = names.map((name) => JSON.parse(readFileSync(join(dir, name, 'mutation.json'), 'utf8')));
  const percent = (/** @type {number} */ n) => `${n.toFixed(2)}%`;
  console.log('| Shard | Files | Killed | Counted | Score |\n|---|---|---|---|---|');
  reports.forEach((report, i) => {
    const s = score(mergeFiles([report]));
    console.log(
      `| ${i + 1} of ${count} | ${Object.keys(report.files ?? {}).length} | ${s.killed} | ${s.total} | ${percent(s.score)} |`,
    );
  });
  const all = mergeFiles(reports);
  const total = score(all);
  console.log(`| All | ${Object.keys(all).length} | ${total.killed} | ${total.total} | ${percent(total.score)} |`);
  if (total.score < floor) {
    console.log(`\nThe combined score ${percent(total.score)} is below the floor of ${floor}% in stryker.config.mjs.`);
    process.exit(1);
  }
  console.log(`\nThe combined score ${percent(total.score)} is at or above the floor of ${floor}%.`);
}
