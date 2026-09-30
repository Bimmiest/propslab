#!/usr/bin/env node
// Fails when a coverage floor has drifted far below what the suite measures.
//
// A floor only ratchets if it sits close to the actual number. At 14–24 points
// under (#506) coverage could fall by double digits with CI still green, and
// the "measured, rounded down" comment above the thresholds was simply untrue.
// vitest enforces `actual >= floor`; this enforces the other half,
// `actual - floor <= MAX_SLACK`, so raising coverage means raising the floor in
// the same change.
//
// Run after `vitest run --coverage` (the config's `json-summary` reporter writes
// coverage/coverage-summary.json):
//
//   node scripts/check-coverage-floors.mjs                       # the app
//   cd packages/mcp-server && node ../../scripts/check-coverage-floors.mjs \
//     vitest.config.mts                                          # the MCP server
//
// Arguments: [config file, default vitest.config.ts] [summary, default
// coverage/coverage-summary.json]. Paths are relative to the working directory.
//
// The config is imported rather than parsed, so the floors checked are exactly
// the ones vitest enforces. Node runs the .ts config by stripping its types.

import { existsSync, readFileSync } from 'node:fs';
import { matchesGlob, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** How far under the measured value a floor may sit, in percentage points. */
export const MAX_SLACK = 3;

const METRICS = ['statements', 'branches', 'functions', 'lines'];

/**
 * Measured percentage for every metric over the summary entries `keep` selects,
 * computed from covered/total counts the way vitest does for a glob threshold.
 */
export function measure(summary, keep) {
  const sums = Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]));
  for (const [file, entry] of Object.entries(summary)) {
    if (file === 'total' || !keep(file)) continue;
    for (const m of METRICS) {
      sums[m].covered += entry[m].covered;
      sums[m].total += entry[m].total;
    }
  }
  return Object.fromEntries(
    METRICS.map((m) => [m, sums[m].total === 0 ? null : (100 * sums[m].covered) / sums[m].total]),
  );
}

/**
 * Problems with `thresholds` against `summary`: one string per floor that is
 * above the measured value, or more than MAX_SLACK below it. `root` is the
 * directory the config's globs are relative to.
 */
export function findProblems(thresholds, summary, root) {
  const problems = [];
  const check = (scope, floors, actual) => {
    for (const m of METRICS) {
      const floor = floors[m];
      if (typeof floor !== 'number') continue;
      const now = actual[m];
      if (now === null) {
        problems.push(`${scope} ${m}: floor ${floor} but no file matches, so nothing is measured`);
      } else if (now < floor) {
        problems.push(`${scope} ${m}: measured ${now.toFixed(2)} is under the floor ${floor}`);
      } else if (now - floor > MAX_SLACK) {
        problems.push(
          `${scope} ${m}: floor ${floor} is ${(now - floor).toFixed(2)} points under the measured ` +
            `${now.toFixed(2)} (at most ${MAX_SLACK} allowed); raise it to ${Math.floor(now) - 1}`,
        );
      }
    }
  };

  const rel = (file) => relative(root, file).split(sep).join('/');
  check('global', thresholds, measure(summary, () => true));
  for (const [glob, floors] of Object.entries(thresholds)) {
    if (typeof floors !== 'object' || floors === null) continue;
    check(glob, floors, measure(summary, (file) => matchesGlob(rel(file), glob)));
  }
  return problems;
}

async function main() {
  const [configArg = 'vitest.config.ts', summaryArg = 'coverage/coverage-summary.json'] = process.argv.slice(2);
  const configPath = resolve(configArg);
  const summaryPath = resolve(summaryArg);
  if (!existsSync(summaryPath)) {
    console.error(`${summaryArg} not found. Run \`vitest run --coverage\` first (json-summary reporter).`);
    process.exit(1);
  }

  const config = (await import(pathToFileURL(configPath).href)).default;
  const thresholds = config?.test?.coverage?.thresholds;
  if (!thresholds) {
    console.error(`${configArg} declares no test.coverage.thresholds`);
    process.exit(1);
  }

  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const problems = findProblems(thresholds, summary, process.cwd());
  if (problems.length > 0) {
    console.error(`Coverage floors in ${configArg} are out of step with the suite (#506):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`Coverage floors in ${configArg} are within ${MAX_SLACK} points of the measured values.`);
}

// Importable for its own test; runs when invoked as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
