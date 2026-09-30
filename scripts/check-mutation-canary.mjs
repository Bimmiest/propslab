#!/usr/bin/env node
// Canary for the Stryker/vitest testNamePattern shim (#508).
//
// vitest.stryker.config.ts patches `testNamePattern` because Stryker and vitest 5
// join test names differently; without the patch every test inside a describe()
// is filtered out, zero tests run per mutant, and every mutant reads as SURVIVED.
// The run then "looks healthy" and simply scores near zero — a whole-engine score
// only notices it hours later, and only if it falls under `thresholds.break`.
//
// This checks a report from a run over one small, thoroughly tested file
// (`npm run test:mutation:canary`, and the first step of mutation.yml). Its
// tests all sit inside describe() blocks, so with the shim broken nearly every
// mutant survives; with it working nearly all are killed. Exit 1 says which.
//
// Usage: node scripts/check-mutation-canary.mjs [report.json] [file]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The file the canary run mutates; keep in step with package.json and mutation.yml. */
export const CANARY_FILE = 'src/engine/utils/wildcardMatch.ts';
/**
 * A run of this file measures 39 killed of 43 (90.7%). The margins are wide on
 * purpose: this detects a broken harness, not a weakened test — the score gate
 * in stryker.config.mjs does that. A broken shim gives ~0 killed.
 */
export const MIN_KILLED = 25;
export const MIN_SCORE = 70;

/** Killed and total counts, ignoring statuses that say nothing about the tests. */
export function tally(mutants) {
  const counted = mutants.filter((m) => ['Killed', 'Timeout', 'Survived', 'NoCoverage'].includes(m.status));
  const killed = counted.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
  return { killed, total: counted.length };
}

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
      `not running per mutant: check the testNamePattern shim in vitest.stryker.config.ts against the ` +
      `installed @stryker-mutator/vitest-runner and vitest.`
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
  console.log('Mutation canary: known-killable mutants are being killed; the testNamePattern shim works.');
}
