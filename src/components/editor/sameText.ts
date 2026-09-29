/**
 * Whether two texts are the same apart from their line endings. A model holds
 * its own EOL (CRLF by default on Windows) whatever EOL the text it was given
 * used, so comparing strictly saw a difference on every remount after an LF
 * example had been loaded, and pushed two spurious undo elements each time.
 */
export function sameText(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');
}
