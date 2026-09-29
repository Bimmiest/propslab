import { useId } from 'react';
import { ReferenceTable } from '../shared/ReferenceTable';
import { REGEX_REFERENCE, REPLACE_CATEGORIES, type RegexCategory, type RegexDirective } from './data';

const REGEX_COLUMNS = [
  { label: 'Pattern', className: 'pb-1 pr-3 font-medium' },
  { label: 'Description', className: 'pb-1 pr-3 font-medium' },
  { label: 'Example', className: 'pb-1 font-medium' },
];
const regexSearchText = (d: RegexDirective) => [d.pattern, d.description, d.example];

/** Regex Reference (collapsible). */
export function RegexReference({ onInsert, onReplace }: { onInsert: (pattern: string) => void; onReplace: (pattern: string) => void }) {
  return (
    <ReferenceTable
      title="Regex Reference"
      searchLabel="Search patterns"
      searchPlaceholder="Search patterns..."
      columns={REGEX_COLUMNS}
      categories={REGEX_REFERENCE}
      searchText={regexSearchText}
      renderCategory={(cat) => <RegexCategoryRows key={cat.name} category={cat} onInsert={onInsert} onReplace={onReplace} />}
    />
  );
}

function RegexCategoryRows({ category, onInsert, onReplace }: { category: RegexCategory; onInsert: (pattern: string) => void; onReplace: (pattern: string) => void }) {
  const isReplace = REPLACE_CATEGORIES.has(category.name);

  return (
    <>
      <tr>
        <td colSpan={3} className="pt-2 pb-0.5 text-[10px] font-medium text-[var(--color-accent)] uppercase tracking-wider">
          {category.name}
          <span className="ml-1.5 font-normal normal-case tracking-normal text-[var(--color-text-muted)]">
            (click to {isReplace ? 'use' : 'append'})
          </span>
        </td>
      </tr>
      {category.directives.map((d) => (
        <RegexReferenceRow
          key={d.pattern}
          directive={d}
          isReplace={isReplace}
          onPick={() => (isReplace ? onReplace(d.pattern) : onInsert(d.pattern))}
        />
      ))}
    </>
  );
}

function RegexReferenceRow({ directive: d, isReplace, onPick }: { directive: RegexDirective; isReplace: boolean; onPick: () => void }) {
  const descriptionId = useId();
  return (
    // Stays a plain row so the table keeps its row and cell semantics: a
    // pressable <tr> gets role="button", which flattens its cells, and its
    // aria-label would replace the description a screen reader reads. The
    // keyboard path is the button in the
    // first cell, described by the description cell; the row's own click is a
    // larger mouse target for the same action.
    <tr
      className="hover:bg-[var(--color-bg-tertiary)] focus-within:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
      onClick={onPick}
      title={isReplace ? `Use pattern: ${d.pattern}` : `Append: ${d.pattern}`}
    >
      <td className="py-0.5 pr-3">
        <button
          type="button"
          // Stopped here so the row's handler does not run the action twice.
          onClick={(e) => { e.stopPropagation(); onPick(); }}
          aria-label={isReplace ? `Use pattern ${d.pattern}` : `Append ${d.pattern}`}
          aria-describedby={descriptionId}
          className="font-mono px-1 py-0.5 rounded text-[11px] text-left bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] border-none cursor-pointer"
        >
          {d.pattern}
        </button>
      </td>
      <td id={descriptionId} className="py-0.5 pr-3 text-[var(--color-text-secondary)]">{d.description}</td>
      <td className="py-0.5 text-[var(--color-text-muted)] font-mono text-[11px]">{d.example}</td>
    </tr>
  );
}
