// Bound the compiled-pattern cache so it can't grow without limit across a long
// session over a large sample (each distinct key/value pair compiles 4 regexes).
// A Map preserves insertion order, so evicting the first key is FIFO.
const PATTERN_CACHE_LIMIT = 500;
const _patternCache = new Map<string, RegExp[]>();

function buildContextPatterns(key: string, value: string): RegExp[] {
  const cacheKey = `${key}\x1f${value}`;
  const cached = _patternCache.get(cacheKey);
  if (cached) return cached;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedVal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The value is wrapped in a capture group and the `d` flag records its start
  // offset, so we highlight the value itself even when the same text also
  // appears in the key (e.g. {"name":"name"}).
  const patterns = [
    new RegExp(`"${escapedKey}"\\s*:\\s*"(${escapedVal})"`, 'gd'), // "key":"value"
    new RegExp(`"${escapedKey}"\\s*:\\s*(${escapedVal})(?=[,}\\s])`, 'gd'), // "key":numvalue
    new RegExp(`(?:^|[\\s,;])${escapedKey}="(${escapedVal})"`, 'gdm'), // key="value"
    new RegExp(`(?:^|[\\s,;])${escapedKey}=(${escapedVal})(?=[,;\\s]|$)`, 'gdm'), // key=value
  ];
  if (_patternCache.size >= PATTERN_CACHE_LIMIT) {
    const oldest = _patternCache.keys().next().value;
    if (oldest !== undefined) _patternCache.delete(oldest);
  }
  _patternCache.set(cacheKey, patterns);
  return patterns;
}

/**
 * Find positions of a field's value in raw text, preferring context-aware matches.
 * For JSON/KV data, matches value only where it appears next to its field key,
 * preventing e.g. "accountId" from claiming "recipientAccountId"'s value.
 *
 * @param originalKey - The original raw key before underscore-stripping (e.g. "_GID" for
 *   field "GID"). When provided, context patterns are tried with this key first so that
 *   stripped-underscore fields from INDEXED_EXTRACTIONS=json can be located correctly.
 */
/** The last dotted segment of a field path (the whole name when it has no dot). */
function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

export function findFieldValuePositions(raw: string, field: string, value: string, originalKey?: string): number[] {
  const leafName = leafOf(field);
  const originalLeaf = originalKey ? leafOf(originalKey) : undefined;

  // Collect unique keys to try. Prefer original (un-stripped) key so `_GID` matches before `GID`.
  const keysToTry = originalLeaf && originalLeaf !== leafName ? [originalLeaf, leafName] : [leafName];

  const contextPositions: number[] = [];
  for (const key of keysToTry) {
    for (const pattern of buildContextPatterns(key, value)) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(raw)) !== null) {
        // indices[1] is the [start, end] of the captured value group.
        const valIdx = match.indices?.[1]?.[0];
        if (valIdx !== undefined) contextPositions.push(valIdx);
      }
    }
    if (contextPositions.length > 0) break; // original key matched — no need to try stripped name
  }

  if (contextPositions.length > 0) return contextPositions;

  // Fallback: plain indexOf — only for values of length >= 2 to avoid false-positive noise.
  // Short values that couldn't be context-matched (e.g. "0", "3") are skipped here; they
  // will only highlight when context matching succeeds above.
  // Only return the first occurrence to prevent double-highlighting of coincidental matches
  // (e.g. a regex-extracted field value that also appears elsewhere in unstructured raw text).
  if (value.length < 2) return [];
  // Require a word boundary around the value so a bare substring match doesn't
  // land inside a larger token — e.g. value "10" must not match the "10" inside
  // "100". Falls back to the first delimiter-bounded occurrence only.
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bounded = new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`);
  const m = bounded.exec(raw);
  return m ? [m.index] : [];
}
