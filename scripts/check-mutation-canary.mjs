#!/usr/bin/env node
// Canary for Stryker's test filter (#508, #796).
//
// Stryker runs each mutant against only the tests that cover it, by giving
// vitest a `testNamePattern` of their full names. If the runner and vitest
// disagree on how a full name is joined (vitest 5 uses " > "), every test inside
// a describe() is filtered out, zero tests run per mutant, and every mutant
// reads as SURVIVED. The run then "looks healthy" and simply scores near zero —
// a whole-engine score only notices it hours later, and only if it falls under
// `thresholds.break`.
//
// This checks a report from a run over one small, thoroughly tested file
// (`npm run test:mutation:canary`, and the first step of mutation.yml). Its
// tests all sit inside describe() blocks, so with the filter broken nearly every
// mutant survives; with it working nearly all are killed. Exit 1 says which.
//
// Usage: node scripts/check-mutation-canary.mjs [report.json] [file]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tally } from './lib/mutationShards.mjs';

/** The file the canary run mutates; keep in step with package.json and mutation.yml. */
export const CANARY_FILE = 'src/engine/utils/wildcardMatch.ts';
/**
 * A run of this file measures 39 killed of 43 (90.7%). The margins are wide on
 * purpose: this detects a broken harness, not a weakened test — the score gate
 * in stryker.config.mjs does that. A broken filter gives ~0 killed.
 */
export const MIN_KILLED = 25;
export const MIN_SCORE = 70;

/** A problem description, or null when the canary run looks healthy. */
export function verdict(report, file = CANARY_FILE) {
  const entry = report.files?.[file];
  if (!entry) return `${file} is not in the report; the canary run did not mutate it`;
  const { killed, total } = tally(entry.mutants);
  const score = total === 0 ? 0 : (100 * killed) / total;
  if (killed < MIN_KILLED || score < MIN_SCORE) {
    return (
      `${file}: only ${killed} of ${total} mutants killed (${score.toFixed(1)}%; expected at least ` +
      `${MIN_KILLED} and ${MIN_SCORE}%). A file this well tested that scores this low means the tests are ` +
      `not running per mutant: check how the installed @stryker-mutator/vitest-runner joins test names ` +
      `for its testNamePattern against how the installed vitest joins them.`
    );
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [reportPath = 'reports/mutation/mutation.json', file = CANARY_FILE] = process.argv.slice(2);
  const problem = verdict(JSON.parse(readFileSync(reportPath, 'utf8')), file);
  if (problem) {
    console.error(`Mutation canary failed: ${problem}`);
    process.exit(1);
  }
  console.log('Mutation canary: known-killable mutants are being killed; Stryker runs the tests of each mutant.');
}
