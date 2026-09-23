import { useAppStore } from '../../store/useAppStore';
import { Overlay } from '../ui/Overlay';
import { Icon } from '../ui/Icon';

function Toggle({
  checked,
  onChange,
  id,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  id: string;
  /** Renders the switch inert — used where a setting is implied by another one. */
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      id={id}
      onClick={onChange}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-bg-tertiary)]',
      ].join(' ')}
    >
      <span
        className={[
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
}

export function SettingsPanel() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const settings = useAppStore((s) => s.settings);
  const togglePerEventPipeline = useAppStore((s) => s.togglePerEventPipeline);
  const toggleManualApply = useAppStore((s) => s.toggleManualApply);

  // Escape closes only the topmost overlay, Tab cycles inside this panel, and
  // sibling content is hidden from assistive tech while it is open.

  if (!settingsOpen) return null;

  return (
    <Overlay
      open={settingsOpen}
      onClose={toggleSettings}
      label="Settings"
      containerClassName=""
    >
      <aside
        className="fixed top-0 right-0 z-50 h-full w-80 flex flex-col shadow-xl"
        style={{
          backgroundColor: 'var(--color-bg-secondary)',
          borderLeft: '1px solid var(--color-border)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 h-12 shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-secondary)' }}>
            Settings
          </span>
          <button
            onClick={toggleSettings}
            aria-label="Close settings"
            className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer border-none"
          >
            <Icon name="x" className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">

          {/* Pipeline section */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--color-text-secondary)' }}>
              Pipeline
            </h3>

            {/* Per-event pipeline toggle */}
            <div
              className="rounded-lg p-3 space-y-2"
              style={{ backgroundColor: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)' }}
            >
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="toggle-per-event" className="text-sm font-medium cursor-pointer" style={{ color: 'var(--color-text-primary)' }}>
                  Re-match stanzas after metadata rewrites
                </label>
                <Toggle
                  id="toggle-per-event"
                  checked={settings.perEventPipeline}
                  onChange={togglePerEventPipeline}
                />
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                Simulates{' '}
                <code className="font-mono text-[11px] px-1 rounded" style={{ backgroundColor: 'var(--color-bg-tertiary)' }}>
                  DEST_KEY = MetaData:*
                </code>{' '}
                correctly. After any index-time transform rewrites the sourcetype, host, or source, stanzas are re-matched and search-time processors (EXTRACT, REPORT, FIELDALIAS, EVAL) apply directives from the new sourcetype.
              </p>
              {settings.perEventPipeline && (
                <p className="text-xs font-medium" style={{ color: 'var(--color-warning)' }}>
                  Pipeline runs per-event — may be slower on large inputs. Manual apply is enabled automatically.
                </p>
              )}
            </div>

            {/* Manual apply toggle */}
            <div
              className="rounded-lg p-3 space-y-2 mt-2"
              style={{ backgroundColor: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-subtle)' }}
            >
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="toggle-manual" className="text-sm font-medium cursor-pointer" style={{ color: 'var(--color-text-primary)' }}>
                  Manual apply
                </label>
                <Toggle
                  id="toggle-manual"
                  checked={settings.manualApply}
                  onChange={toggleManualApply}
                  disabled={settings.perEventPipeline}
                />
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                Disables live updates while you type. Use the{' '}
                <strong>Run pipeline</strong> button in the status bar to process changes.{' '}
                {settings.perEventPipeline
                  ? 'Required while per-event mode is on, so it cannot be turned off here.'
                  : 'Recommended when per-event mode is on.'}
              </p>
            </div>
          </section>

        </div>
      </aside>
    </Overlay>
  );
}
