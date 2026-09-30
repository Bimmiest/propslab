import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { isFieldActive, isAnyFocused } from './useFieldFocus';
import { type FieldNode, flattenVisibleTree } from './fieldTreeUtils';
import { useWindowedRows } from '../../../../hooks/useWindowedRows';
import { pressable } from '../../../ui/pressable';
import { copyQuietly } from '../../../../utils/clipboard';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
} from '../../../ui/ContextMenu';
import { tint } from '../../../../utils/tint';
import { Icon } from '../../../ui/Icon';

interface FieldTreeProps {
  collapsed: Set<string>;
  toggleGroup: (name: string) => void;
  activeFields: Set<string> | null;
  pinnedFields: Set<string>;
  onHover: (field: string | null) => void;
  onClick: (field: string) => void;
}

/**
 * The field sidebar's tree, flattened and windowed (#454): a wide JSON event
 * can put thousands of fields here. `scrollRef` is the sidebar's scrolling
 * list, which this renders into.
 *
 * The rows are one Tab stop (roving tabindex, as in the dictionary listbox):
 * hundreds of `tabIndex=0` rows would make the list impossible to Tab past.
 * Arrow keys, Home and End move between rows; Enter and Space act on one.
 */
export function FieldTreeList({
  tree,
  search,
  scrollRef,
  ...rowProps
}: FieldTreeProps & { tree: FieldNode[]; search: string; scrollRef: RefObject<HTMLElement | null> }) {
  const rows = useMemo(() => flattenVisibleTree(tree, rowProps.collapsed, search), [tree, rowProps.collapsed, search]);
  const { segments, onFocus } = useWindowedRows(scrollRef, rows.length, { estimate: 24 });

  // The roving row, by name so it survives a filter or a collapse reshaping
  // the list. If it is windowed out (or gone), the first rendered row takes
  // the tab stop, so the list can always be tabbed into.
  const [activeName, setActiveName] = useState<string | null>(null);
  const renderedIndexes = segments.flatMap((seg) => (seg.kind === 'row' ? [seg.index] : []));
  const activeIndex = rows.findIndex((row) => row.node.name === activeName);
  const tabStopIndex = renderedIndexes.includes(activeIndex) ? activeIndex : (renderedIndexes[0] ?? -1);

  const containerRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const focusRow = useCallback((index: number): boolean => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-window-index="${index}"] [data-field-row]`);
    if (!el) return false;
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
    return true;
  }, []);

  // A move to a row that was not rendered (Home/End across a long list)
  // scrolls it into the window first; the focus lands once it has mounted.
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index !== null && focusRow(index)) pendingFocus.current = null;
  }, [segments, focusRow]);

  const handleFocus = (e: FocusEvent<HTMLElement>) => {
    onFocus(e);
    const name = e.target instanceof HTMLElement ? e.target.dataset['fieldRow'] : undefined;
    if (name !== undefined) setActiveName(name);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Only from a row itself: keys in the context menu, portalled but still
    // inside this React subtree, are the menu's.
    const { target: source } = e;
    if (!(source instanceof HTMLElement) || source.dataset['fieldRow'] === undefined) return;
    const current = rows.findIndex((row) => row.node.name === source.dataset['fieldRow']);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(current + 1, rows.length - 1);
    else if (e.key === 'ArrowUp') next = Math.max(current - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    if (next < 0 || current < 0) return;
    e.preventDefault();
    const target = rows[next];
    if (!target) return;
    setActiveName(target.node.name);
    if (focusRow(next)) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rowHeight =
      containerRef.current?.querySelector<HTMLElement>('[data-window-row]')?.getBoundingClientRect().height || 24;
    pendingFocus.current = next;
    scroller.scrollTop = next * rowHeight;
  };

  return (
    // The handlers are delegated from the rows, which are the focusable
    // elements; the container is not itself interactive.
    <div ref={containerRef} onFocus={handleFocus} onKeyDown={handleKeyDown}>
      {segments.map((seg) => {
        if (seg.kind === 'spacer') return <div key={seg.key} aria-hidden="true" style={{ height: seg.height }} />;
        const row = rows[seg.index];
        return (
          row && (
            <FieldTreeRow
              key={row.node.name}
              node={row.node}
              indent={row.indent}
              index={seg.index}
              tabStop={seg.index === tabStopIndex}
              {...rowProps}
            />
          )
        );
      })}
    </div>
  );
}

function FieldTreeRow({
  node,
  indent,
  index,
  tabStop,
  collapsed,
  toggleGroup,
  activeFields,
  pinnedFields,
  onHover,
  onClick,
}: FieldTreeProps & { node: FieldNode; indent: number; index: number; tabStop: boolean }) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.name);
  const focused = isAnyFocused(activeFields);
  const active = isFieldActive(node.name, activeFields);
  const pinned = pinnedFields.has(node.name);

  const row = (
    <div
      className="flex items-center gap-1 px-1.5 py-0.5 min-h-6 rounded cursor-pointer select-none group"
      style={{
        backgroundColor: pinned ? tint(node.color, 13) : active && focused ? tint(node.color, 8) : 'transparent',
        borderLeft: active && focused ? `2px solid ${node.color}` : '2px solid transparent',
        transition: 'background-color 0.15s, border-color 0.15s',
      }}
      onMouseEnter={() => onHover(node.name)}
      onMouseLeave={() => onHover(null)}
      {...pressable(
        () => (hasChildren ? toggleGroup(node.name) : onClick(node.name)),
        (focused) => onHover(focused ? node.name : null),
      )}
      // After the spread, which makes every row a tab stop.
      tabIndex={tabStop ? 0 : -1}
      data-field-row={node.name}
      {...(hasChildren ? { 'aria-expanded': !isCollapsed } : { 'aria-pressed': pinned })}
    >
      {hasChildren ? (
        <Icon
          name="chevron-down"
          className="w-3 h-3 flex-shrink-0 transition-transform"
          style={{ color: 'var(--color-text-muted)', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
        />
      ) : (
        <span
          className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
          style={{
            backgroundColor: tint(node.color, 25),
            borderLeft: `2px solid ${node.color}`,
            outline: pinned ? `1.5px solid ${node.color}` : 'none',
            outlineOffset: '1px',
          }}
        />
      )}

      <span
        className="text-xs truncate"
        style={{ color: hasChildren ? 'var(--color-text-secondary)' : 'var(--color-text-primary)' }}
        title={node.name}
      >
        {node.depth > 0 ? `.${node.leafName}` : node.name}
      </span>

      {hasChildren && (
        <span className="text-[9px] text-[var(--color-text-muted)] flex-shrink-0">({node.children.length})</span>
      )}
      {pinned && (
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 ml-auto" style={{ backgroundColor: node.color }} />
      )}
    </div>
  );

  return (
    <div style={{ paddingLeft: `${indent}px` }} data-window-row="" data-window-index={index}>
      {hasChildren ? (
        row
      ) : (
        <ContextMenu>
          <ContextMenuTrigger>{row}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>{node.name}</ContextMenuLabel>
            <ContextMenuItem onSelect={() => copyQuietly(node.name)}>Copy field name</ContextMenuItem>
            <ContextMenuItem onSelect={() => onClick(node.name)}>
              {pinned ? 'Unpin field' : 'Pin field'}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
    </div>
  );
}
