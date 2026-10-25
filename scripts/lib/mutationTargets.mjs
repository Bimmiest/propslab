// Which files a pull request's mutation run mutates, from what it changed:
// the selection behind scripts/mutation-targets.mjs, apart from git (#571).

import { posix } from 'node:path';
import stryker from '../../stryker.config.mjs';
import { resolveImport, staticImports } from './entryGraph.mjs';

/** Stryker's `mutate` list: the one place the mutation scope is written. */
export const MUTATE_GLOBS = /** @type {string[]} */ (stryker.mutate);

/**
 * A glob of the form Stryker's `mutate` list uses, as a regular expression:
 * `**` spans directories, `*` stays within one, and `**\/` also matches none.
 * @param {string} glob
 */
function globRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (c === '*') {
      out += '[^/]*';
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * The files of `files` that `globs` select, in order: matched by a glob and by
 * no `!` glob, as Stryker reads its `mutate` list.
 * @param {string[]} files
 * @param {string[]} globs
 * @returns {string[]}
 */
export function selectMutated(files, globs) {
  const include = globs.filter((g) => !g.startsWith('!')).map(globRegExp);
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => globRegExp(g.slice(1)));
  return files.filter((f) => include.some((re) => re.test(f)) && !exclude.some((re) => re.test(f)));
}

/** Whether `file` is a test or test support, which is never mutated itself. */
export function isTestFile(file) {
  return /(?:^|\/)__tests__\/|\.test\.tsx?$/.test(file);
}

/**
 * The source files a test file imports directly, resolved to paths that
 * exist: a changed test is what changed about how those are tested.
 * @param {string} testFile
 * @param {string} source the test file's text
 * @param {(path: string) => boolean} exists
 * @returns {string[]}
 */
export function importedSources(testFile, source, exists) {
  const found = [];
  for (const spec of staticImports(source)) {
    const base = resolveImport(testFile, spec);
    const path = [base, `${base}.ts`, `${base}.tsx`, posix.join(base, 'index.ts')].find(
      (p) => /\.tsx?$/.test(p) && exists(p),
    );
    if (path !== undefined) found.push(path);
  }
  return found;
}
