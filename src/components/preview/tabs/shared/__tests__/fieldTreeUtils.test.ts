import { describe, it, expect } from 'vitest';
import { buildFieldTree, flattenVisibleTree, type FieldNode } from '../fieldTreeUtils';

/** Build the colour map from a list of field names (colours are irrelevant to structure). */
function colorMap(names: string[]): Map<string, string> {
  return new Map(names.map((n, i) => [n, `#00000${i % 10}`]));
}

/** Collapse a tree to `name(child,child)` strings for concise structural assertions. */
function shape(nodes: FieldNode[]): string[] {
  return nodes.map((n) =>
    n.children.length ? `${n.name}(${shape(n.children).join(',')})` : n.name,
  );
}

describe('buildFieldTree', () => {
  it('nests JSON-flattened leaves under synthesized container nodes', () => {
    // Mirrors AWS Network Firewall extraction: only leaf fields exist; `event` and
    // `event.alert` are never extracted as fields, yet must appear as group headers.
    const fields = [
      'availability_zone',
      'event.alert.action',
      'event.alert.category',
      'event.app_proto',
      'event.verdict.action',
      'firewall_name',
    ];
    const roots = buildFieldTree(colorMap(fields), new Set(), new Map());

    expect(shape(roots)).toEqual([
      'availability_zone',
      'event(event.alert(event.alert.action,event.alert.category),event.app_proto,event.verdict(event.verdict.action))',
      'firewall_name',
    ]);
  });

  it('marks synthesized parents as containers and keeps real depth', () => {
    const roots = buildFieldTree(colorMap(['event.alert.action']), new Set(), new Map());
    const event = roots[0]!;
    expect(event.name).toBe('event');
    expect(event.isContainer).toBe(true);
    expect(event.depth).toBe(0);
    const alert = event.children[0]!;
    expect(alert.name).toBe('event.alert');
    expect(alert.isContainer).toBe(true);
    expect(alert.depth).toBe(1);
    const action = alert.children[0]!;
    expect(action.isContainer).toBe(false);
    expect(action.depth).toBe(2);
    expect(action.children).toHaveLength(0);
  });

  it('inherits a synthesized container colour from its first descendant leaf', () => {
    const map = new Map<string, string>([['event.alert.action', '#abcdef']]);
    const roots = buildFieldTree(map, new Set(), new Map());
    expect(roots[0]!.color).toBe('#abcdef'); // event
    expect(roots[0]!.children[0]!.color).toBe('#abcdef'); // event.alert
  });

  it('keeps a top-level field that is also a parent of nested fields as one node', () => {
    // Both `a` and `a.b` extracted: `a` is a real field AND a container.
    const roots = buildFieldTree(colorMap(['a', 'a.b']), new Set(['a']), new Map());
    expect(roots).toHaveLength(1);
    expect(roots[0]!.name).toBe('a');
    expect(roots[0]!.color).toBe('#000000'); // real colour, not the synthetic placeholder
    expect(shape(roots)).toEqual(['a(a.b)']);
  });
});

describe('flattenVisibleTree', () => {
  const tree = () => buildFieldTree(colorMap(['a.b.c', 'a.b.d', 'a.e', 'z']), new Set(), new Map());
  const names = (rows: { node: FieldNode }[]) => rows.map((r) => r.node.name);

  it('lists every node in tree order, each level indented by its depth past its parent', () => {
    const rows = flattenVisibleTree(tree(), new Set(), '');
    expect(names(rows)).toEqual(['a', 'a.b', 'a.b.c', 'a.b.d', 'a.e', 'z']);
    // The nested sidebar added each level's depth × 10 to its parent's padding.
    expect(rows.map((r) => r.indent)).toEqual([0, 10, 30, 30, 10, 0]);
  });

  it('hides the children of a collapsed node but keeps the node', () => {
    expect(names(flattenVisibleTree(tree(), new Set(['a.b']), ''))).toEqual(['a', 'a.b', 'a.e', 'z']);
  });

  it('keeps a match and the ancestors leading to it, and nothing else', () => {
    expect(names(flattenVisibleTree(tree(), new Set(), 'a.b.d'))).toEqual(['a', 'a.b', 'a.b.d']);
  });
});
