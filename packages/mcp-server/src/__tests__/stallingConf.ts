/**
 * A props.conf `[evil]` stanza that holds a run on its one event for far
 * longer than any test waits. Each EXTRACT backtracks exponentially on a line
 * of a's until it spends the most steps a match can take, 10,000,000, which
 * takes about 0.2 s. MATCH_LIMIT = 0 raises the limit to that cap but no
 * longer switches it off (#560), so it takes a few hundred of them.
 */
export function stallingStanza(group = '(a|aa)+', extracts = 300): string {
  return [
    '[evil]',
    'SHOULD_LINEMERGE = false',
    'MATCH_LIMIT = 0',
    'DEPTH_LIMIT = 0',
    ...Array.from({ length: extracts }, (_, i) => `EXTRACT-boom${i === 0 ? '' : i + 1} = ^(?<boom>${group})(?=b)$`),
  ].join('\n');
}

/** The one event {@link stallingStanza} stalls on. */
export const STALLING_RAW = `${'a'.repeat(200)}\n`;
