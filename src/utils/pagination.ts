/** The index, in the whole list, of the first item on a 1-based page. */
export const pageStart = (page: number, perPage: number) => (page - 1) * perPage;

/** A page number the user typed, as a page that exists, or null when it is not a number. */
export function parsePageInput(text: string, totalPages: number): number | null {
  const n = Number.parseInt(text.trim(), 10);
  if (Number.isNaN(n)) return null;
  return Math.min(Math.max(n, 1), totalPages);
}
