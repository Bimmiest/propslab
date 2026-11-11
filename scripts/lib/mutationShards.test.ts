import { describe, it, expect } from 'vitest';
import { assignShards, mergeFiles, score, shardCount, tally } from './mutationShards.mjs';

// The weekly mutation run in shards (#851): which files each shard mutates,
// and how the shards' reports become one score.
const mutants = (counts: Record<string, number>) =>
  Object.entries(counts).flatMap(([status, n]) => Array.from({ length: n }, () => ({ status })));

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

describe('assignShards', () => {
  const files = [
    { path: 'a.ts', size: 50 },
    { path: 'b.ts', size: 40 },
    { path: 'c.ts', size: 30 },
    { path: 'd.ts', size: 20 },
    { path: 'e.ts', size: 10 },
    { path: 'f.ts', size: 10 },
  ];

  it('gives each file to exactly one shard', () => {
    const shards = assignShards(files, 3);
    expect(shards.flat().sort()).toEqual(files.map((f) => f.path));
  });

  it('puts the largest file first into the shard with the least cost so far', () => {
    // a(50) → 1; b(40) → 2; c(30) → 2 (40 < 50); d(20) → 1 (50 < 70);
    // e(10) → 1 (a tie at 70); f(10) → 2 (70 < 80).
    expect(assignShards(files, 2)).toEqual([
      ['a.ts', 'd.ts', 'e.ts'],
      ['b.ts', 'c.ts', 'f.ts'],
    ]);
  });

  it('gives the same shards whatever the order of the input', () => {
    expect(assignShards([...files].reverse(), 3)).toEqual(assignShards(files, 3));
  });

  it('breaks a tie of size by path, and a tie of cost by the lower shard', () => {
    expect(
      assignShards(
        [
          { path: 'y.ts', size: 5 },
          { path: 'x.ts', size: 5 },
        ],
        2,
      ),
    ).toEqual([['x.ts'], ['y.ts']]);
  });

  it('leaves a shard empty when there are fewer files than shards', () => {
    expect(assignShards([{ path: 'a.ts', size: 1 }], 2)).toEqual([['a.ts'], []]);
  });

  it('refuses a count that is not a positive integer', () => {
    expect(() => assignShards(files, 0)).toThrow(/positive integer, not 0/);
    expect(() => assignShards(files, 1.5)).toThrow(RangeError);
  });
});

describe('shardCount', () => {
  it('gives the count when every shard has a report', () => {
    expect(shardCount(['mutation-report-2-of-3', 'mutation-report-1-of-3', 'mutation-report-3-of-3'])).toBe(3);
  });

  it('names each missing shard', () => {
    expect(() => shardCount(['mutation-report-2-of-4'])).toThrow('There is no report from shard 1, 3, 4 of 4.');
  });

  it('refuses reports from runs with different counts', () => {
    expect(() => shardCount(['mutation-report-1-of-2', 'mutation-report-2-of-3'])).toThrow(/different shard counts/);
  });

  it('refuses a name that is not a shard report', () => {
    expect(() => shardCount(['mutation-report'])).toThrow(/mutation-report is not a shard report/);
  });

  it('refuses no reports', () => {
    expect(() => shardCount([])).toThrow(/no shard reports/);
  });
});

describe('mergeFiles and score', () => {
  const report = (path: string, counts: Record<string, number>) => ({
    files: { [path]: { mutants: mutants(counts) } },
  });

  it('scores the files of all shards together, not the mean of the shard scores', () => {
    const files = mergeFiles([report('a.ts', { Killed: 9, Survived: 1 }), report('b.ts', { Killed: 1, Survived: 9 })]);
    expect(Object.keys(files)).toEqual(['a.ts', 'b.ts']);
    expect(score(files)).toEqual({ killed: 10, total: 20, score: 50 });
    const weighted = mergeFiles([report('a.ts', { Killed: 90, Survived: 10 }), report('b.ts', { Survived: 1 })]);
    expect(score(weighted).score).toBeCloseTo((100 * 90) / 101);
  });

  it('refuses a file in two shard reports', () => {
    expect(() => mergeFiles([report('a.ts', { Killed: 1 }), report('a.ts', { Killed: 1 })])).toThrow(
      'a.ts is in two shard reports.',
    );
  });

  it('accepts a report with no files', () => {
    expect(mergeFiles([{}, report('a.ts', { Killed: 1 })])).toEqual(report('a.ts', { Killed: 1 }).files);
  });

  it('scores nothing as 0', () => {
    expect(score({})).toEqual({ killed: 0, total: 0, score: 0 });
  });
});
