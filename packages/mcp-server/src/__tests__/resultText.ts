/** A tool result's first text block; every result the server builds has one. */
export function resultText(r: { content: readonly { text: string }[] }): string {
  const [first] = r.content;
  if (first === undefined) throw new Error('tool result has no content');
  return first.text;
}
