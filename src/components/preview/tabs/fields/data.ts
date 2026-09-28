/** The Fields tab's columns and the sort and filter choices over them. */

export type SortKey = 'name' | 'count' | 'distinct' | 'source' | 'aliases' | 'values';
export type SortDir = 'asc' | 'desc';
export type PhaseFilter = 'all' | 'index-time' | 'search-time';

export interface ColumnDef {
  key: SortKey;
  label: string;
  defaultWidth: number;
  minWidth: number;
}

export const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Field Name', defaultWidth: 180, minWidth: 20 },
  { key: 'aliases', label: 'Aliases', defaultWidth: 140, minWidth: 20 },
  { key: 'count', label: 'Events', defaultWidth: 80, minWidth: 20 },
  { key: 'distinct', label: 'Distinct Values', defaultWidth: 100, minWidth: 20 },
  { key: 'source', label: 'Phase', defaultWidth: 150, minWidth: 20 },
  { key: 'values', label: 'Sample Values', defaultWidth: 300, minWidth: 20 },
];
