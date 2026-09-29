/** A named group of rows in a reference table. */
export interface ReferenceCategory<R> {
  name: string;
  directives: R[];
}

/**
 * The categories with only the rows one of whose texts contains `query`,
 * case-insensitively, and without the categories left empty. An empty query
 * returns `categories` itself.
 */
export function filterReference<R>(
  categories: ReferenceCategory<R>[],
  query: string,
  searchText: (row: R) => string[],
): ReferenceCategory<R>[] {
  if (!query) return categories;
  const lower = query.toLowerCase();
  return categories
    .map((cat) => ({
      ...cat,
      directives: cat.directives.filter((d) => searchText(d).some((t) => t.toLowerCase().includes(lower))),
    }))
    .filter((cat) => cat.directives.length > 0);
}
