import { copyQuietly } from '../../../../utils/clipboard';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel } from '../../../ui/ContextMenu';
import { Icon } from '../../../ui/Icon';
import type { FieldRow } from './fieldRows';

export function FieldTableRow({
  field, rowId, rowIndex, eventCount, columnWidths, collapsed, childCount, controls, onToggle,
}: {
  field: FieldRow;
  rowId: string | undefined;
  /** Position among the visible rows; aria-rowindex counts the header as 1. */
  rowIndex: number;
  eventCount: number;
  columnWidths: Record<string, number>;
  collapsed: boolean;
  childCount: number;
  controls: string | undefined;
  onToggle: (parent: string) => void;
}) {
  return (
    <ContextMenu>
    <ContextMenuTrigger>
    <tr
      id={rowId}
      aria-rowindex={rowIndex + 2}
      data-window-row=""
      data-window-index={rowIndex}
      className="border-b border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-secondary)] transition-colors">
      <td className="py-1.5 px-3 font-mono font-medium" style={{ width: columnWidths['name'] }}>
        <div className="flex items-center gap-1.5">
          <FieldNameCell
            name={field.name}
            depth={field.depth}
            isParent={field.isParent}
            parentName={field.parentName}
            collapsed={collapsed}
            childCount={childCount}
            controls={controls}
            onToggle={onToggle}
          />
          {field.maskedBy.size > 0 && (
            <span
              className="inline-block flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium font-sans bg-[var(--color-warning)]/10 text-[var(--color-warning)]"
              title={`Value rewritten at index time by ${Array.from(field.maskedBy).join(', ')}. The extraction works — the value it finds is not the original.`}
            >
              masked
            </span>
          )}
        </div>
      </td>
      <td className="py-1.5 px-3" style={{ width: columnWidths['aliases'] }}>
        <AliasChips name={field.name} aliases={field.aliases} />
      </td>
      <td className="py-1.5 px-3 text-[var(--color-text-secondary)]" style={{ width: columnWidths['count'] }}>
        {field.count}/{eventCount}
      </td>
      <td className="py-1.5 px-3 text-[var(--color-text-secondary)]" style={{ width: columnWidths['distinct'] }}>
        {field.values.size}
      </td>
      <td className="py-1.5 px-3" style={{ width: columnWidths['source'] }}>
        <PhaseChips phases={field.phases} sources={field.sources} />
      </td>
      <td className="py-1.5 px-3 font-mono text-[var(--color-text-secondary)] truncate" style={{ width: columnWidths['values'], maxWidth: columnWidths['values'] }}>
        {Array.from(field.values).slice(0, 3).join(', ')}
      </td>
    </tr>
    </ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuLabel>{field.name}</ContextMenuLabel>
      <ContextMenuItem onSelect={() => copyQuietly(field.name)}>Copy field name</ContextMenuItem>
      <ContextMenuItem onSelect={() => copyQuietly(Array.from(field.values).join(', '))}>Copy sample values</ContextMenuItem>
    </ContextMenuContent>
    </ContextMenu>
  );
}

/** The FIELDALIASes that also name a field. */
function AliasChips({ name, aliases }: { name: string; aliases: FieldRow['aliases'] }) {
  if (aliases.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {aliases.map((alias) => (
        <span
          key={alias}
          className="inline-block px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] font-mono text-xs"
          title={`FIELDALIAS: ${name} AS ${alias}`}
        >
          {alias}
        </span>
      ))}
    </div>
  );
}

/** The phases (index-time, search-time) that extracted a field, each titled with the processors behind it. */
function PhaseChips({ phases, sources }: Pick<FieldRow, 'phases' | 'sources'>) {
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from(phases).map((phase) => (
        <span
          key={phase}
          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={
            phase === 'index-time'
              ? { backgroundColor: 'var(--color-accent)', color: 'var(--color-text-on-accent)' }
              : { backgroundColor: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }
          }
          title={Array.from(sources).join(', ')}
        >
          {phase}
        </span>
      ))}
    </div>
  );
}

/** The expand/collapse chevron on a parent field's row. */
function ToggleChevron({ name, collapsed, controls, onToggle }: {
  name: string;
  collapsed: boolean;
  controls: string | undefined;
  onToggle: (parent: string) => void;
}) {
  return (
    <button
      className="flex items-center justify-center w-4 h-4 rounded hover:bg-[var(--color-bg-tertiary)] cursor-pointer bg-transparent border-none p-0 transition-colors"
      onClick={() => onToggle(name)}
      // Named for the field it toggles, so a screen reader can tell a column
      // of them apart. The name stays fixed and `aria-expanded` carries the
      // state: a name that flipped between "Expand" and "Collapse" would
      // announce the change twice.
      aria-label={`Toggle ${name}`}
      aria-expanded={!collapsed}
      aria-controls={controls}
    >
      <Icon
        name="chevron-down"
        className="w-3 h-3 transition-transform"
        style={{
          color: 'var(--color-text-muted)',
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
        }}
      />
    </button>
  );
}

function FieldNameCell({
  name, depth, isParent, parentName, collapsed, childCount, controls, onToggle,
}: {
  name: string;
  depth: number;
  isParent: boolean;
  parentName: string | null;
  collapsed: boolean;
  childCount: number;
  /** Space-separated ids of the child rows the toggle shows and hides, when rendered. */
  controls: string | undefined;
  onToggle: (parent: string) => void;
}) {
  // Leaf name relative to immediate parent (e.g. "instanceId" from "responseElements.instancesSet.items.0.instanceId")
  const leafName = parentName ? name.substring(parentName.length + 1) : name;
  const chevron = <ToggleChevron name={name} collapsed={collapsed} controls={controls} onToggle={onToggle} />;

  if (depth === 0) {
    return (
      <span className="flex items-center gap-1 font-medium text-[var(--color-text-primary)]">
        {isParent && chevron}
        {name}
        {isParent && (
          <span
            className="text-[9px] px-1 py-px rounded"
            style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-text-on-accent)' }}
          >
            JSON
          </span>
        )}
        {isParent && collapsed && (
          <span className="text-[9px] text-[var(--color-text-muted)]">
            ({childCount})
          </span>
        )}
      </span>
    );
  }

  // Sub-field: show indented with tree connector + optional expand chevron if it's also a parent
  return (
    <span
      className="flex items-center text-[var(--color-text-secondary)]"
      style={{ paddingLeft: `${Math.min(depth, 6) * 12 + (isParent ? 0 : 16)}px` }}
    >
      {isParent ? chevron : (
        <span className="text-[var(--color-text-muted)] mr-1" aria-hidden="true">
          {'└─'}
        </span>
      )}
      <span title={name}>
        .{leafName}
      </span>
      {isParent && (
        <span
          className="text-[9px] px-1 py-px rounded ml-1"
          style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-text-on-accent)' }}
        >
          JSON
        </span>
      )}
      {isParent && collapsed && (
        <span className="text-[9px] text-[var(--color-text-muted)] ml-1">
          ({childCount})
        </span>
      )}
    </span>
  );
}
