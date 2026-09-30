import { describe, it, expect } from 'vitest';
import { CANARY_FILE, MIN_KILLED, MIN_SCORE, tally, verdict } from '../../scripts/check-mutation-canary.mjs';

// The canary for the Stryker/vitest testNamePattern shim (#508). Reading the
// report is the script's own; what can be wrong is deciding from it.
const mutants = (counts: Record<string, number>) =>
  Object.entries(counts).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })));
const report = (counts: Record<string, number>, file = CANARY_FILE) => ({
  files: { [file]: { mutants: mutants(counts) } },
});

describe('tally', () => {
  it('counts a timeout as a kill, a survivor and an uncovered mutant as not', () => {
    expect(tally(mutants({ Killed: 5, Timeout: 2, Survived: 3, NoCoverage: 1 }))).toEqual({ killed: 7, total: 11 });
  });

  it('ignores statuses that say nothing about the tests', () => {
    expect(tally(mutants({ Killed: 4, Ignored: 9, CompileError: 2, RuntimeError: 1 }))).toEqual({
      killed: 4,
      total: 4,
    });
  });

  it('is zero of zero for no mutants', () => {
    expect(tally([])).toEqual({ killed: 0, total: 0 });
  });
});

describe('verdict', () => {
  it('passes a healthy run', () => {
    expect(verdict(report({ Killed: 39, Survived: 4 }))).toBeNull();
  });

  it('fails a run in which almost nothing is killed, the signature of the broken shim', () => {
    const problem = verdict(report({ Killed: 1, Survived: 42 }));
    expect(problem).toMatch(/only 1 of 43 mutants killed/);
    expect(problem).toMatch(/testNamePattern shim/);
  });

  it('needs both the count and the score', () => {
    // Enough kills, too low a share.
    expect(verdict(report({ Killed: MIN_KILLED, Survived: 100 }))).not.toBeNull();
    // A high share, too few kills to mean anything.
    expect(verdict(report({ Killed: MIN_KILLED - 1 }))).not.toBeNull();
    // The most mutants the kills can be a passing share of.
    const total = Math.floor((100 * MIN_KILLED) / MIN_SCORE);
    expect(verdict(report({ Killed: MIN_KILLED, Survived: total - MIN_KILLED }))).toBeNull();
  });

  it('fails a report with no mutants for the file rather than dividing by zero', () => {
    expect(verdict(report({}))).toMatch(/only 0 of 0 mutants killed \(0\.0%/);
  });

  it('says so when the file was not mutated at all', () => {
    expect(verdict({ files: {} })).toBe(`${CANARY_FILE} is not in the report; the canary run did not mutate it`);
    expect(verdict({})).toMatch(/is not in the report/);
  });

  it('reads the file it is asked about', () => {
    expect(verdict(report({ Killed: 40 }, 'src/other.ts'), 'src/other.ts')).toBeNull();
    expect(verdict(report({ Killed: 40 }, 'src/other.ts'))).toMatch(/is not in the report/);
  });
});
