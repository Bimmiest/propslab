/**
 * Whole-string `*` glob matching, in linear time (#344).
 *
 * A glob is not a regex, and compiling one to a backtracking regex — each `*`
 * to `.*` — made the matcher exponential in the number of stars: XML_IE_*
 * lists are tested against element values from the event, and
 * `*a*a*a*a*b` against 200 `a`s took seconds. Nothing about a `*`-only glob
 * needs backtracking. The text before the first star must be a prefix, the
 * text after the last a suffix, and each segment between them can take its
 * leftmost occurrence after the previous one: an earlier match never leaves
 * less room for what follows, so the greedy choice is always safe.
 *
 * Semantics are those the regex had: anchored at both ends, case-sensitive,
 * `*` matches any run of characters including newlines and the empty string,
 * and every other character — `?`, `.`, `\` included — is literal. Matching
 * is by UTF-16 code unit, as the non-`u` regex's `.` was.
 */
export type WildcardMatcher = (s: string) => boolean;

export function compileWildcard(pattern: string): WildcardMatcher {
  const parts = pattern.split('*');
  if (parts.length === 1) return (s) => s === pattern;

  const head = parts[0]!;
  const tail = parts[parts.length - 1]!;
  // Adjacent stars leave empty segments, which match anywhere.
  const middle = parts.slice(1, -1).filter(Boolean);
  const fixed = head.length + tail.length;

  return (s) => {
    // The prefix and the suffix must not overlap.
    if (s.length < fixed || !s.startsWith(head) || !s.endsWith(tail)) return false;
    const end = s.length - tail.length;
    let pos = head.length;
    for (const segment of middle) {
      const at = s.indexOf(segment, pos);
      if (at === -1 || at + segment.length > end) return false;
      pos = at + segment.length;
    }
    return true;
  };
}
