/**
 * Where the character class opening at `start` ends: just past its closing
 * `]`, read as PCRE reads it, or -1 when nothing closes it. A `]` first in the
 * class (after any `^`) is a member; an escape is skipped whole; and a POSIX
 * class such as `[:digit:]` is skipped to its `:]`, PCRE's rule being that one
 * with a `]` before that is not a POSIX class.
 */
export function classEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === '^') i++;
  if (pattern[i] === ']') i++;
  while (i < pattern.length) {
    if (pattern[i] === ']') return i + 1;
    if (pattern[i] === '\\') {
      i += 2;
    } else if (pattern.startsWith('[:', i)) {
      const close = pattern.indexOf(':]', i + 2);
      i = close !== -1 && !pattern.slice(i + 2, close).includes(']') ? close + 2 : i + 1;
    } else {
      i++;
    }
  }
  return -1;
}
