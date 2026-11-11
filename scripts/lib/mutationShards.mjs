// The full mutation run in shards (#851). One job cannot run past GitHub's
// 6-hour limit, so the weekly run divides Stryker's `mutate` list across the
// jobs of a matrix, and a last job holds the combined score to the floor.

/**
 * @typedef {{ status: string, duration?: number }} Mutant
 * @typedef {{ files?: Record<string, { mutants: Mutant[] }> }} Report
 */

/**
 * Killed and total counts, as Stryker's score counts them: a timeout is a
 * detection, and a mutant that did not compile or was ignored says nothing
 * about the tests.
 * @param {Mutant[]} mutants
 */
export function tally(mutants) {
  const counted = mutants.filter((m) => ['Killed', 'Timeout', 'Survived', 'NoCoverage'].includes(m.status));
  const killed = counted.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
  return { killed, total: counted.length };
}

/**
 * Divides `files` into `count` shards of about equal cost: the largest file
 * first, each to the shard with the least cost so far, and on a tie to the
 * lower shard. The cost of a file is its size, because a larger file has more
 * mutants. The same files give the same shards, so a rerun mutates the same
 * files in each shard.
 * @param {{ path: string, size: number }[]} files
 * @param {number} count
 * @returns {string[][]} the paths of each shard, sorted
 */
export function assignShards(files, count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`The shard count must be a positive integer, not ${count}.`);
  }
  const shards = Array.from({ length: count }, () => ({ cost: 0, paths: /** @type {string[]} */ ([]) }));
  const ordered = [...files].sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
  for (const file of ordered) {
    const lightest = shards.reduce((min, shard) => (shard.cost < min.cost ? shard : min));
    lightest.cost += file.size;
    lightest.paths.push(file.path);
  }
  return shards.map((shard) => shard.paths.sort());
}

const SHARD_REPORT = /^mutation-report-(\d+)-of-(\d+)$/;

/**
 * The shard count of a run, from the names of its report directories
 * (`mutation-report-<shard>-of-<count>`). A missing shard would raise the
 * combined score with no sign, so it is an error, and so is a name from a run
 * with a different count.
 * @param {string[]} names
 * @returns {number}
 */
export function shardCount(names) {
  const parsed = names.map((name) => {
    const match = SHARD_REPORT.exec(name);
    if (!match) throw new Error(`${name} is not a shard report: expected mutation-report-<shard>-of-<count>.`);
    return { shard: Number(match[1]), count: Number(match[2]) };
  });
  const count = parsed[0]?.count;
  if (count === undefined) throw new Error('There are no shard reports.');
  if (parsed.some((p) => p.count !== count)) throw new Error('The shard reports have different shard counts.');
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((i) => !parsed.some((p) => p.shard === i));
  if (missing.length > 0) throw new Error(`There is no report from shard ${missing.join(', ')} of ${count}.`);
  return count;
}

/**
 * The files of all shard reports in one map. A file in two reports means that
 * the shards overlapped, and its mutants would count twice.
 * @param {Report[]} reports
 * @returns {Record<string, { mutants: Mutant[] }>}
 */
export function mergeFiles(reports) {
  /** @type {Record<string, { mutants: Mutant[] }>} */
  const files = {};
  for (const report of reports) {
    for (const [path, entry] of Object.entries(report.files ?? {})) {
      if (Object.hasOwn(files, path)) throw new Error(`${path} is in two shard reports.`);
      files[path] = entry;
    }
  }
  return files;
}

/**
 * The score of `files` in percent, 0 when nothing counts.
 * @param {Record<string, { mutants: Mutant[] }>} files
 */
export function score(files) {
  const { killed, total } = tally(Object.values(files).flatMap((entry) => entry.mutants));
  return { killed, total, score: total === 0 ? 0 : (100 * killed) / total };
}
