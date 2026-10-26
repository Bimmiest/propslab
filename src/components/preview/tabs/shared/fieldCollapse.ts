/**
 * Collapse/visibility logic for the nested field table, extracted from
 * `FieldsTab`'s render so it can be reasoned about and tested on its own.
 */

/** The parts of a field row this module needs. */
export interface CollapsibleField {
  name: string;
  depth: number;
  parentName: string | null;
}

/**
 * Map each field name to its parent, so an ancestor walk is O(depth) rather
 * than O(n) per step: the walk runs for every row on each render of a table
 * that can hold thousands of rows.
 */
export function buildParentIndex(fields: CollapsibleField[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const field of fields) index.set(field.name, field.parentName);
  return index;
}

/** True when no ancestor of `field` is collapsed. */
export function isFieldVisible(
  field: CollapsibleField,
  collapsed: ReadonlySet<string>,
  parentIndex: ReadonlyMap<string, string | null>,
): boolean {
  if (field.depth === 0) return true;
  let current = field.parentName;
  // A malformed index (a cycle) would otherwise spin forever; bound the walk by
  // the number of known fields, which is the deepest a valid chain can be.
  let guard = parentIndex.size + 1;
  while (current && guard-- > 0) {
    if (collapsed.has(current)) return false;
    current = parentIndex.get(current) ?? null;
  }
  return true;
}
