/**
 * Copy text to the clipboard, with a fallback for insecure contexts where the
 * async Clipboard API is unavailable. Shared by CopyButton and the context menus.
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Async Clipboard API unavailable (insecure context) — fall back below.
  }

  // Remember the previous selection and active element to restore later
  const previousSelection = document.getSelection();
  const previousActiveElement = document.activeElement as HTMLElement | null;
  const previousSelectionRange = previousSelection?.rangeCount ? previousSelection.getRangeAt(0) : null;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.setAttribute('aria-hidden', 'true');
  textarea.readOnly = true;
  document.body.appendChild(textarea);

  // Select the text; for iOS, explicitly set the selection range
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  // Deliberately uninitialized: the try below either assigns or throws past
  // the read, so a seed value would be dead (no-useless-assignment). A finally
  // without a catch still leaves `ok` definitely assigned at the read.
  let ok: boolean;
  try {
    // execCommand can return false (or throw in a sandboxed iframe) without
    // copying. Propagate that as a rejection so callers don't show a false
    // "copied" confirmation.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the fallback for when the Clipboard API is unavailable
    ok = document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);

    // Restore the previous selection and focus
    if (previousSelectionRange) {
      const selection = document.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(previousSelectionRange);
      }
    }
    if (previousActiveElement) {
      previousActiveElement.focus();
    }
  }
  if (!ok) throw new Error('Copy to clipboard failed');
}

/**
 * Copy without reporting failure, for context-menu items and other callers with
 * nowhere to show it.
 *
 * `copyToClipboard` rejects when the copy did not happen, so that callers with a
 * "Copied!" confirmation do not show one for a copy that never occurred. Callers
 * with no such UI still have to settle the promise — left floating, a failed
 * copy surfaces as an unhandled rejection in the console.
 */
export function copyQuietly(text: string): void {
  void copyToClipboard(text).catch(() => {
    // Nothing to report it with; the clipboard is simply unchanged.
  });
}
