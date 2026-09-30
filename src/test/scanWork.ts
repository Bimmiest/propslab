// ---------------------------------------------------------------------------
// scanWork.ts
// A count of the work a function does, for tests of a linear-time claim (#507).
//
// A stopwatch assertion is a coin flip on a loaded runner: it fails when the
// machine is slow and passes when it is fast, whatever the code does. What a
// "linear time" test is really after is that the work does not grow faster than
// the input, and that can be counted.
//
// The count is the size of what each call to a scan-shaped built-in touches
// while the function runs: the string methods that copy or search a string and
// the array methods that scan or copy an array. A copy (slice, join, concat,
// filter) is counted at the size of what it produced; a search (indexOf,
// includes, find, split, replace) at the size of what it may look through, from
// the position it starts at. A loop that re-slices, re-joins or re-searches a
// growing value once per item adds the whole value each time, so its total
// grows with the square of the input; a linear one adds a short piece each
// time. It is an upper bound (a `find` that stops early is counted in full),
// which is fine for telling a factor of n apart from a factor of 2.
//
// It counts what goes through those built-ins and nothing else: a `+` on
// strings, or a backtracking regex, is invisible to it. Use it where the
// quadratic shape is a slice, a join or a scan; where the cost hides inside one
// regex call, size the input so the quadratic version overruns the test's own
// timeout instead.
// ---------------------------------------------------------------------------

import { expect } from 'vitest';

type Cost = (self: { length: number }, args: unknown[], result: unknown) => number;

/** What a copying call produced. */
const produced: Cost = (_self, _args, result) => (result as { length?: number } | null)?.length ?? 0;
/** Everything the call may look through. */
const looked: Cost = (self) => self.length;
/** What a call that starts at a position may look through: the rest. */
const lookedFrom: Cost = (self, args) => Math.max(0, self.length - (typeof args[1] === 'number' ? args[1] : 0));
/** A prefix or suffix test compares only as much as the needle. */
const needle: Cost = (_self, args) => (typeof args[0] === 'string' ? args[0].length : 0);

const STRING_METHODS: Record<string, Cost> = {
  slice: produced,
  substring: produced,
  substr: produced,
  concat: produced,
  padStart: produced,
  padEnd: produced,
  trim: produced,
  trimStart: produced,
  trimEnd: produced,
  indexOf: lookedFrom,
  includes: lookedFrom,
  lastIndexOf: looked,
  startsWith: needle,
  endsWith: needle,
  replace: looked,
  replaceAll: looked,
  split: looked,
};

const ARRAY_METHODS: Record<string, Cost> = {
  slice: produced,
  splice: produced,
  concat: produced,
  join: looked,
  filter: looked,
  map: looked,
  indexOf: lookedFrom,
  includes: lookedFrom,
  lastIndexOf: looked,
  find: looked,
  findIndex: looked,
  findLast: looked,
  findLastIndex: looked,
  some: looked,
  every: looked,
  reduce: looked,
};

type Patchable = Record<string, unknown>;

/**
 * The total size touched by scan-shaped built-ins while `fn` runs. Pass a map
 * to also learn where it went: it is filled with the work per call site, for
 * finding the loop when a bound fails.
 */
export function scanWork(fn: () => void, bySite?: Map<string, number>): number {
  let work = 0;
  let counting = true;
  const restore: (() => void)[] = [];

  const patch = (proto: object, methods: Record<string, Cost>): void => {
    for (const [name, cost] of Object.entries(methods)) {
      const original = (proto as Patchable)[name];
      if (typeof original !== 'function') continue;
      const wrapped = function (this: { length: number }, ...args: unknown[]): unknown {
        const result: unknown = Reflect.apply(original, this, args);
        if (counting) {
          const spent = cost(this, args, result);
          work += spent;
          if (bySite) {
            counting = false; // the stack capture below must not count itself
            const site = `${name} ${new Error().stack?.split('\n')[2]?.trim() ?? ''}`;
            bySite.set(site, (bySite.get(site) ?? 0) + spent);
            counting = true;
          }
        }
        return result;
      };
      (proto as Patchable)[name] = wrapped;
      restore.push(() => {
        (proto as Patchable)[name] = original;
      });
    }
  };

  patch(String.prototype, STRING_METHODS);
  patch(Array.prototype, ARRAY_METHODS);
  try {
    fn();
  } finally {
    counting = false;
    for (const undo of restore) undo();
  }
  return work;
}

/**
 * Asserts that doubling the input does not much more than double the work.
 * Linear work doubles; quadratic work quadruples; the bound sits between, at 3x.
 *
 * `run(size)` builds an input of that size and returns the call to measure, so
 * building the input is not counted. The work at the smaller size must be
 * non-zero, or the counter saw nothing and the test proves nothing.
 */
export function expectLinearWork(run: (size: number) => () => void, size: number): void {
  const small = scanWork(run(size));
  const large = scanWork(run(size * 2));
  expect(small, 'the counter saw no work, so the bound below would hold vacuously').toBeGreaterThan(0);
  expect(large, `work went from ${String(small)} to ${String(large)} when the input doubled`).toBeLessThanOrEqual(
    3 * small,
  );
}
