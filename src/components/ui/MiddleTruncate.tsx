/** How many characters at the end stay visible when the text is cut. */
export const KEPT_TAIL = 6;

/**
 * Text that, when it does not fit, is cut in the middle (`bytes_…ceived`)
 * instead of at the end. Field names often share a prefix (`bytes_received`,
 * `bytes_sent`, `bytes_total`), and a cut at the end showed each of them as
 * the same "byt…" (#893).
 *
 * The visible copy is in two parts, the start that can shrink to an ellipsis
 * and the tail that cannot. They are hidden from assistive technology, which
 * reads the whole text once from its own copy: a browser can put a space
 * between the two parts when it computes a name from the content.
 *
 * Put it in a flex row; it takes the room that its siblings leave.
 */
export function MiddleTruncate({ text, className = '' }: { text: string; className?: string }) {
  // Too short to have a middle: a cut at the end loses as little.
  if (text.length <= KEPT_TAIL + 2) return <span className={`truncate ${className}`}>{text}</span>;
  return (
    <span className={`flex min-w-0 ${className}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="truncate">
        {text.slice(0, -KEPT_TAIL)}
      </span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre">
        {text.slice(-KEPT_TAIL)}
      </span>
    </span>
  );
}
