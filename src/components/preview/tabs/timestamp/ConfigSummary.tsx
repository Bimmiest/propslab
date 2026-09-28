import type { TimeConfig } from '../../../../engine/timestampMatch';
import { tint } from '../../../../utils/tint';
import { FORMAT_COLOR, LOOKAHEAD_COLOR, PREFIX_COLOR } from './data';

/** Config summary: the timestamp settings in force, and what the format's directives mean. */
export function ConfigSummary({ config, directives }: {
  config: TimeConfig;
  directives: { directive: string; description: string }[];
}) {
  return (
    <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <ConfigValue label="TIME_PREFIX" value={config.timePrefix} color={PREFIX_COLOR} />
        <ConfigValue label="TIME_FORMAT" value={config.timeFormat} color={FORMAT_COLOR} />
        <ConfigValue label="MAX_TIMESTAMP_LOOKAHEAD" value={Number.isFinite(config.maxLookahead) ? config.maxLookahead.toString() : 'no limit'} color={LOOKAHEAD_COLOR} />
        {config.tz && <ConfigValue label="TZ" value={config.tz} />}
      </div>
      {directives.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-1.5">
          {directives.map((d, i) => (
            <span key={i} className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
              <code className="px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-success)] font-mono">{d.directive}</code>
              {d.description}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function TimestampLegend() {
  return (
    <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-4 text-[10px]">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: tint(PREFIX_COLOR, 25), borderBottom: `2px solid ${PREFIX_COLOR}` }} />
          <span className="text-[var(--color-text-muted)]">TIME_PREFIX match</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: tint(FORMAT_COLOR, 25), borderBottom: `2px solid ${FORMAT_COLOR}` }} />
          <span className="text-[var(--color-text-muted)]">TIME_FORMAT match</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] font-bold leading-none" style={{ color: LOOKAHEAD_COLOR }}>]</span>
          <span className="text-[var(--color-text-muted)]">Lookahead boundary</span>
        </span>
      </div>
    </div>
  );
}

function ConfigValue({ label, value, color }: { label: string; value: string | null; color?: string }) {
  return (
    <span className="text-[var(--color-text-muted)]">
      {label}={' '}
      {value ? (
        <code className="font-mono font-medium px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)]" style={{ color }}>
          {value}
        </code>
      ) : (
        <span className="italic">not set</span>
      )}
    </span>
  );
}
