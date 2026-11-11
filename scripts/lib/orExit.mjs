// The value of a read that a script cannot go on without, or exit 1 with a
// message that says what to do. The scripts in scripts/ read the build output
// or an installed package at the top level; this keeps each result a `const`
// rather than a `let` assigned inside a `try` (#865).

/**
 * Returns what `read` returns. When it throws, prints `message` to stderr and
 * exits the process with code 1.
 * @template T
 * @param {() => T} read
 * @param {string} message
 * @returns {T}
 */
export function orExit(read, message) {
  try {
    return read();
  } catch {
    console.error(message);
    return process.exit(1);
  }
}
