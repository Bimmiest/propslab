/**
 * `localStorage` that never throws. Storage can be unavailable (a privacy
 * mode, blocked site data, a full quota), and a preference that cannot be
 * read or saved is not worth an error.
 */
export const safeStorage = {
  /** The stored value, or `onError` when storage cannot be read. */
  get(key: string, onError: string | null = null): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return onError;
    }
  },
  /** Store the value; when storage is unavailable, do nothing. */
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};
