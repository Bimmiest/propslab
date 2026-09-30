import { ReferenceTable } from '../shared/ReferenceTable';
import { STRPTIME_REFERENCE, type StrptimeCategory, type StrptimeDirective } from './data';
import { isSimulated } from './timestampLogic';

const STRPTIME_COLUMNS = [
  { label: 'Directive', className: 'pb-1 pr-3 font-medium w-16' },
  { label: 'Description', className: 'pb-1 pr-3 font-medium' },
  { label: 'Example', className: 'pb-1 font-medium w-32' },
];
const strptimeSearchText = (d: StrptimeDirective) => [d.directive, d.description, d.example];

/** The collapsible, searchable strptime reference table. */
export function StrptimeReference({ activeDirectives }: { activeDirectives: string[] }) {
  return (
    <ReferenceTable
      title="STRPTIME Reference"
      searchLabel="Search strptime directives"
      searchPlaceholder="Search directives..."
      panelId="strptime-reference"
      columns={STRPTIME_COLUMNS}
      categories={STRPTIME_REFERENCE}
      searchText={strptimeSearchText}
      renderCategory={(cat) => (
        <StrptimeCategoryRows key={cat.name} category={cat} activeDirectives={activeDirectives} />
      )}
    />
  );
}

function StrptimeCategoryRows({
  category,
  activeDirectives,
}: {
  category: StrptimeCategory;
  activeDirectives: string[];
}) {
  return (
    <>
      <tr>
        <td
          colSpan={3}
          className="pt-2 pb-0.5 text-[10px] font-medium text-[var(--color-accent)] uppercase tracking-wider"
        >
          {category.name}
        </td>
      </tr>
      {category.directives.map((d) => {
        const isActive = activeDirectives.includes(d.directive);
        return (
          <tr
            key={d.directive}
            className="hover:bg-[var(--color-bg-tertiary)] transition-colors"
            style={isActive ? { backgroundColor: 'var(--color-accent-muted, rgba(59,130,246,0.1))' } : undefined}
          >
            <td className="py-0.5 pr-3">
              <code
                className="font-mono px-1 py-0.5 rounded text-[11px]"
                style={{
                  color: isActive ? 'var(--color-success)' : 'var(--color-text-primary)',
                  backgroundColor: isActive
                    ? 'var(--color-success-bg, rgba(34,197,94,0.15))'
                    : 'var(--color-bg-tertiary)',
                }}
              >
                {d.directive}
              </code>
            </td>
            <td className="py-0.5 pr-3 text-[var(--color-text-secondary)]">
              {d.description}
              {/* Text, not colour alone: Splunk reads these, the preview does not. */}
              {!isSimulated(d.directive) && (
                <span
                  className="ml-1.5 px-1 rounded text-[10px] font-medium bg-[var(--color-warning)]/10 text-[var(--color-warning)]"
                  title={`${d.directive} is not simulated: the preview treats it as literal text, though a real indexer parses it.`}
                >
                  not simulated
                </span>
              )}
            </td>
            <td className="py-0.5 text-[var(--color-text-muted)] font-mono text-[11px]">{d.example}</td>
          </tr>
        );
      })}
    </>
  );
}
