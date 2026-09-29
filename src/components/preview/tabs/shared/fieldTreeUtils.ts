export interface FieldNode {
  name: string;
  leafName: string;
  color: string;
  processor: string | null;
  isContainer: boolean;
  depth: number;
  children: FieldNode[];
}

// Placeholder colour for synthesized container nodes; replaced in a final pass with
// the colour of the container's first descendant leaf (see resolveContainerColor).
const SYNTHETIC_CONTAINER_COLOR = '#94a3b8';

export function buildFieldTree(
  fieldColorMap: Map<string, string>,
  containerFields: Set<string>,
  fieldProcessorMap: Map<string, string>,
): FieldNode[] {
  const roots: FieldNode[] = [];
  const nodeMap = new Map<string, FieldNode>();
  // Paths we created as intermediate containers rather than as real extracted
  // fields. Splunk's JSON flattening only emits leaf fields, so the parent objects
  // (`event`, `event.alert`, …) never exist as fields of their own — without
  // synthesizing them, nested fields collapse into depth-indented roots that
  // visually nest under whatever unrelated root happens to precede them.
  const synthesized = new Set<string>();

  // Link a node under its parent, creating any missing ancestor containers.
  function link(node: FieldNode, parts: string[]): void {
    if (parts.length > 1) {
      ensureContainer(parts.slice(0, -1).join('.')).children.push(node);
    } else {
      roots.push(node);
    }
  }

  function ensureContainer(path: string): FieldNode {
    const existing = nodeMap.get(path);
    if (existing) return existing;
    const parts = path.split('.');
    const node: FieldNode = {
      name: path,
      leafName: parts.at(-1) ?? path,
      color: SYNTHETIC_CONTAINER_COLOR,
      processor: fieldProcessorMap.get(path) ?? null,
      isContainer: true,
      depth: parts.length - 1,
      children: [],
    };
    nodeMap.set(path, node);
    synthesized.add(path);
    link(node, parts);
    return node;
  }

  for (const name of Array.from(fieldColorMap.keys()).sort()) {
    const parts = name.split('.');
    const existing = nodeMap.get(name);
    if (existing) {
      // This path was already synthesized as a container but is ALSO a real
      // extracted field (e.g. both `a.b` and `a.b.c` were extracted). Promote it
      // to a real node: adopt its true colour/processor and keep its children.
      existing.color = fieldColorMap.get(name)!;
      existing.processor = fieldProcessorMap.get(name) ?? existing.processor;
      synthesized.delete(name);
      continue;
    }
    const node: FieldNode = {
      name,
      leafName: parts.at(-1) ?? name,
      color: fieldColorMap.get(name)!,
      processor: fieldProcessorMap.get(name) ?? null,
      isContainer: containerFields.has(name),
      depth: parts.length - 1,
      children: [],
    };
    nodeMap.set(name, node);
    link(node, parts);
  }

  // Synthesized containers have no colour of their own (they aren't extracted
  // values), so give each one the colour of its first descendant leaf — the group
  // header then reads as a visual set with the fields it contains.
  const resolveContainerColor = (node: FieldNode): string => {
    const firstChild = node.children[0];
    if (firstChild === undefined) return node.color;
    const childColor = resolveContainerColor(firstChild);
    if (synthesized.has(node.name)) node.color = childColor;
    return node.color;
  };
  roots.forEach(resolveContainerColor);

  return roots;
}

export function nodeMatchesSearch(node: FieldNode, search: string): boolean {
  if (!search) return true;
  if (node.name.toLowerCase().includes(search)) return true;
  return node.children.some((c) => nodeMatchesSearch(c, search));
}

/** A sidebar row: a node, and how far it is indented. */
export interface VisibleFieldNode {
  node: FieldNode;
  /** Left padding in px, each level adding its own depth × 10 to its parent's. */
  indent: number;
}

/**
 * The rows the field sidebar shows, in order: every node that matches the
 * search or has a descendant that does, below parents that are expanded.
 * Flat, so the list can be windowed (#454).
 */
export function flattenVisibleTree(roots: FieldNode[], collapsed: Set<string>, search: string): VisibleFieldNode[] {
  const out: VisibleFieldNode[] = [];
  const visit = (node: FieldNode, parentIndent: number) => {
    if (!nodeMatchesSearch(node, search)) return;
    const indent = parentIndent + node.depth * 10;
    out.push({ node, indent });
    if (collapsed.has(node.name)) return;
    for (const child of node.children) visit(child, indent);
  };
  for (const root of roots) visit(root, 0);
  return out;
}
