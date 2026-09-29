import { tint } from '../../../../utils/tint';

export function GroupChips({ namedGroups, groupColorMap }: { namedGroups: string[]; groupColorMap: Map<string, string> }) {
  return (
    <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex flex-wrap gap-1.5">
        {namedGroups.map((name) => {
          const color = groupColorMap.get(name) ?? '';
          return (
            <span
              key={name}
              className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: tint(color, 13), color, border: `1px solid ${tint(color, 25)}` }}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              {name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function GroupLegend({ namedGroups, groupColorMap }: { namedGroups: string[]; groupColorMap: Map<string, string> }) {
  return (
    <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-4 text-[10px] flex-wrap">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: '#22c55e40', borderBottom: '2px solid #22c55e' }} />
          <span className="text-[var(--color-text-muted)]">Full match</span>
        </span>
        {namedGroups.map((name) => {
          const color = groupColorMap.get(name) ?? '';
          return (
            <span key={name} className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: tint(color, 25), borderBottom: `2px solid ${color}` }} />
              <span className="text-[var(--color-text-muted)]">{name}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
