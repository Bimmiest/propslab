import { useAppStore } from '../../store/useAppStore';
import type { EventMetadata } from '../../engine/types';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';

const metadataFields: { key: keyof EventMetadata; label: string; hint: string }[] = [
  { key: 'index', label: 'index', hint: 'Splunk index where the event is stored' },
  { key: 'host', label: 'host', hint: 'Matches host:: stanzas in props.conf' },
  { key: 'source', label: 'source', hint: 'Matches source:: stanzas in props.conf' },
  { key: 'sourcetype', label: 'sourcetype', hint: 'Matches [sourcetype] stanzas in props.conf — the most important field for pipeline matching' },
];

export function MetadataPanel() {
  const metadata = useAppStore((s) => s.metadata);
  const setMetadataField = useAppStore((s) => s.setMetadataField);
  const collapsed = useAppStore((s) => !!s.collapsedPanels['metadata']);
  const toggleCollapse = useAppStore((s) => s.togglePanelCollapse);

  return (
    <div>
      <button
        type="button"
        onClick={() => toggleCollapse('metadata')}
        className="w-full flex items-center gap-2 px-3 py-2 hover:opacity-80 transition-opacity border-t border-[var(--color-border-subtle)]"
        aria-expanded={!collapsed}
      >
        <Icon
          name="chevron-down"
          className={`w-3 h-3 text-[var(--color-text-muted)] transition-transform ${collapsed ? '-rotate-90' : ''}`}
        />
        <Icon name="tag" className="w-3.5 h-3.5 text-[var(--color-accent)]" />
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Metadata</span>
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-1.5 px-3 pb-3">
          {metadataFields.map(({ key, label, hint }) => {
            // sourcetype drives [stanza] matching — emphasise it over the others.
            const emphasized = key === 'sourcetype';
            return (
              <div key={key} className="flex items-center gap-2">
                <div className="w-24 shrink-0 flex items-center gap-1">
                  <label
                    htmlFor={`metadata-${key}`}
                    className="text-[10px] font-semibold uppercase tracking-wider truncate"
                    style={{ color: emphasized ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
                  >
                    {label}
                  </label>
                  <Tooltip content={hint} side="top">
                    <button
                      type="button"
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors p-0 border-none bg-transparent cursor-default shrink-0"
                      aria-label={`Info about ${label}`}
                    >
                      <Icon name="info" className="w-3 h-3 opacity-60" />
                    </button>
                  </Tooltip>
                </div>
                <input
                  id={`metadata-${key}`}
                  type="text"
                  value={metadata[key]}
                  onChange={(e) => setMetadataField(key, e.target.value)}
                  placeholder={key === 'index' ? 'main' : key}
                  spellCheck={false}
                  className="flex-1 min-w-0 px-2 py-1 text-xs font-mono rounded-md outline-none bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] border border-[var(--color-border)] focus:border-[var(--color-accent)] transition-colors"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
