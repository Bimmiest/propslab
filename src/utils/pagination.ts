/** The index, in the whole list, of the first item on a 1-based page. */
export const pageStart = (page: number, perPage: number) => (page - 1) * perPage;
