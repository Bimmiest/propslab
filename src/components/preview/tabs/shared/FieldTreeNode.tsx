import { isFieldActive, isAnyFocused } from './useFieldFocus';
import { type FieldNode, nodeMatchesSearch } from './fieldTreeUtils';
import { pressable } from '../../../ui/pressable';
import { copyQuietly } from '../../../../utils/clipboard';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel } from '../../../ui/ContextMenu';

interface FieldTreeNodeProps {
  node: FieldNode;
  collapsed: Set<string>;
  toggleGroup: (name: string) => void;
  activeFields: Set<string> | null;
  pinnedFields: Set<string>;
  onHover: (field: string | null) => void;
  onClick: (field: string) => void;
  search: string;
}

export function FieldTreeNode({
  node, collapsed, toggleGroup, activeFields, pinnedFields, onHover, onClick, search,
}: FieldTreeNodeProps) {
  const matchesSelf = !search || node.name.toLowerCase().includes(search);
  const childMatchesSearch = node.children.some((c) => nodeMatchesSearch(c, search));
  if (!matchesSelf && !childMatchesSearch) return null;

  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.name);
  const focused = isAnyFocused(activeFields);
  const active = isFieldActive(node.name, activeFields);
  const pinned = pinnedFields.has(node.name);

  const row = (
      <div
        className="flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer select-none group"
        style={{
          backgroundColor: pinned ? node.color + '20' : (active && focused ? node.color + '15' : 'transparent'),
          borderLeft: active && focused ? `2px solid ${node.color}` : '2px solid transparent',
          transition: 'background-color 0.15s, border-color 0.15s',
        }}
        onMouseEnter={() => onHover(node.name)}
        onMouseLeave={() => onHover(null)}
        {...pressable(
          () => hasChildren ? toggleGroup(node.name) : onClick(node.name),
          (focused) => onHover(focused ? node.name : null),
        )}
        {...(hasChildren ? { 'aria-expanded': !isCollapsed } : { 'aria-pressed': pinned })}
      >
        {hasChildren ? (
          <svg
            className="w-3 h-3 flex-shrink-0 transition-transform"
            style={{ color: 'var(--color-text-muted)', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        ) : (
          <span
            className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
            style={{
              backgroundColor: node.color + '40',
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
    <div style={{ paddingLeft: `${node.depth * 10}px` }}>
      {hasChildren ? row : (
        <ContextMenu>
          <ContextMenuTrigger>{row}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>{node.name}</ContextMenuLabel>
            <ContextMenuItem onSelect={() => copyQuietly(node.name)}>Copy field name</ContextMenuItem>
            <ContextMenuItem onSelect={() => onClick(node.name)}>{pinned ? 'Unpin field' : 'Pin field'}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      {hasChildren && !isCollapsed && node.children.map((child) => (
        <FieldTreeNode
          key={child.name}
          node={child}
          collapsed={collapsed}
          toggleGroup={toggleGroup}
          activeFields={activeFields}
          pinnedFields={pinnedFields}
          onHover={onHover}
          onClick={onClick}
          search={search}
        />
      ))}
    </div>
  );
}
