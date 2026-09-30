import { Icon } from '../ui/Icon';
import { MultiSelect } from '../ui/MultiSelect';

interface PreviewFilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  allFields: string[];
  selectedFields: ReadonlySet<string>;
  onFieldsChange: (fields: Set<string>) => void;
  selectedStatus: ReadonlySet<string>;
  onStatusChange: (status: Set<string>) => void;
  selectedChangeState: ReadonlySet<string>;
  onChangeStateChange: (mod: Set<string>) => void;
  filteredCount: number;
  totalCount: number;
}

const STATUS_OPTIONS = ['Accepted', 'Dropped'];
const CHANGE_STATE_OPTIONS = ['Raw Modified', 'Metadata Modified', 'Unmodified'];

export function PreviewFilterBar({
  search,
  onSearchChange,
  allFields,
  selectedFields,
  onFieldsChange,
  selectedStatus,
  onStatusChange,
  selectedChangeState,
  onChangeStateChange,
  filteredCount,
  totalCount,
}: PreviewFilterBarProps) {
  const hasFilters = search || selectedFields.size > 0 || selectedStatus.size > 0 || selectedChangeState.size > 0;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="relative flex-1 max-w-[240px]">
        <Icon
          name="search"
          className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none text-[var(--color-text-muted)]"
        />
        <input
          type="text"
          aria-label="Search events"
          placeholder="Search events…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-7 pr-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>
      <MultiSelect label="Fields" options={allFields} selected={selectedFields} onChange={onFieldsChange} searchable />
      <MultiSelect label="Status" options={STATUS_OPTIONS} selected={selectedStatus} onChange={onStatusChange} />
      <MultiSelect
        label="Changes"
        options={CHANGE_STATE_OPTIONS}
        selected={selectedChangeState}
        onChange={onChangeStateChange}
      />
      {hasFilters && (
        <span className="text-xs whitespace-nowrap ml-auto tabular-nums" style={{ color: 'var(--color-accent)' }}>
          {filteredCount} / {totalCount}
        </span>
      )}
    </div>
  );
}
