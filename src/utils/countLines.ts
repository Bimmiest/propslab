/**
 * Lines in `text` (0 when empty), found with indexOf rather than split: the raw
 * panel counts its whole buffer on every keystroke, and split allocates a
 * string per line only to throw them away.
 */
export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}
