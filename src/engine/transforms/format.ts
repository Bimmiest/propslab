// FORMAT: splitting a search-time FORMAT into its `key::value` pairs, and
// substituting `$N` / `${name}` capture references into a FORMAT (or one half
// of a pair). Nothing here knows about DEST_KEY beyond taking the value `$0`
// stands for.

// Pre-compiled patterns for format string substitution.
const CAPTURE_REF_PATTERN = /\$(\d+)/g;
const NAMED_REF_PATTERN = /\$\{(\w+)\}/g;

/** One `key::value` token from a search-time FORMAT, still holding its `$N` references. */
export interface FormatPair {
  key: string;
  value: string;
}

/**
 * Split a FORMAT string into its `key::value` pairs *without* substituting
 * captures, so a capture containing spaces or `::` cannot change the pair
 * structure (transforms.conf.spec, "FORMAT for search-time extractions").
 *
 * Both halves may hold `$N` references — `FORMAT = $1::$2` names the field from
 * one capture and its value from another. A value may be double-quoted to carry
 * literal whitespace: `field::"a b"`.
 */
export function parseFormatPairs(format: string): FormatPair[] {
  const pairs: FormatPair[] = [];
  let i = 0;

  while (i < format.length) {
    while (i < format.length && /\s/.test(format.charAt(i))) i++;
    if (i >= format.length) break;

    // Keys never contain whitespace, so the `::` separator must appear in the
    // run that starts here. A run without one is stray text — skip it.
    let runEnd = i;
    while (runEnd < format.length && !/\s/.test(format.charAt(runEnd))) runEnd++;
    const sep = format.indexOf('::', i);
    if (sep < 0) break;
    if (sep >= runEnd) {
      i = runEnd;
      continue;
    }

    const key = format.slice(i, sep);
    i = sep + 2;

    let value: string;
    if (format.charAt(i) === '"') {
      const end = format.indexOf('"', i + 1);
      if (end < 0) {
        value = format.slice(i + 1);
        i = format.length;
      } else {
        value = format.slice(i + 1, end);
        i = end + 1;
      }
    } else {
      let end = i;
      while (end < format.length && !/\s/.test(format.charAt(end))) end++;
      value = format.slice(i, end);
      i = end;
    }

    if (key) pairs.push({ key, value });
  }

  return pairs;
}

export function expandFormat(format: string, match: RegExpExecArray, priorDestValue?: string): string {
  // match[0] is the whole match; match[1..maxIndex] are the capture groups.
  const maxIndex = match.length - 1;
  let result = format.replace(CAPTURE_REF_PATTERN, (whole: string, digits: string) => {
    // The pattern greedily grabs every trailing digit, but a reference resolves
    // to at most `maxIndex`. Mirror PCRE/JS `$nn` fallback: take the LONGEST
    // leading digit-run that names an existing group; any remaining digits are
    // literal text. (So with one group, `$10` → group 1 followed by a literal
    // `0`, not the non-existent group 10.)
    for (let len = digits.length; len > 0; len--) {
      const idx = parseInt(digits.slice(0, len), 10);
      if (idx <= maxIndex) {
        // transforms.conf.spec: `$0` is "what was in the DEST_KEY before the
        // REGEX was performed", not the whole match. Use the prior DEST_KEY value
        // when one is known; fall back to the whole match otherwise (e.g. field
        // extractions with no DEST_KEY).
        const base = idx === 0 && priorDestValue !== undefined ? priorDestValue : (match[idx] ?? '');
        return base + digits.slice(len);
      }
    }
    // No leading digit-run names a real group — leave the `$N` text untouched.
    return whole;
  });
  if (match.groups) {
    const groups = match.groups;
    result = result.replace(NAMED_REF_PATTERN, (_: string, name: string) => groups[name] ?? '');
  }
  return result;
}
