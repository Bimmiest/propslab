import { useMemo } from 'react';
import { useAppStore, EMPTY_INPUTS } from '../../store/useAppStore';
import { ThemeToggle } from '../ui/ThemeToggle';
import { ProgressBar } from '../ui/ProgressBar';
import { Icon, type IconName } from '../ui/Icon';
import { ClearButton } from '../editor/ClearButton';
import { Tooltip } from '../ui/Tooltip';
import { countByLevel } from '../../utils/diagnosticCounts';
import { ExamplesMenu } from '../examples/ExamplesMenu';
import { getModifierName, isApplePlatform } from '../../utils/platform';

/** A header button that opens a side panel, highlighted while the panel is open. */
function PanelToggle({
  tooltip,
  label,
  icon,
  open,
  onClick,
}: {
  tooltip: string;
  label: string;
  icon: IconName;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={tooltip} side="bottom">
      <button
        onClick={onClick}
        aria-label={label}
        aria-expanded={open}
        className={[
          'flex items-center justify-center w-8 h-8 rounded-md border-none outline-none',
          'focus-visible:ring-2 press cursor-pointer',
          open
            ? 'bg-[var(--color-accent)] text-[var(--color-text-on-accent)]'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]',
        ].join(' ')}
      >
        <Icon name={icon} className="w-[18px] h-[18px]" />
      </button>
    </Tooltip>
  );
}

export function Header() {
  const diagnostics = useAppStore((s) => s.validationDiagnostics);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const result = useAppStore((s) => s.processingResult);
  const loadInputs = useAppStore((s) => s.loadInputs);
  const toggleHelp = useAppStore((s) => s.toggleHelp);
  const helpOpen = useAppStore((s) => s.helpOpen);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const settingsOpen = useAppStore((s) => s.settingsOpen);

  // Its own click-twice confirmation already guards this; loading the empty
  // inputs also makes them the clean baseline selectSessionDirty compares to.
  const resetAll = () => loadInputs(EMPTY_INPUTS);

  // Coerce to boolean INSIDE the selector so Zustand compares the boolean, not the
  // raw text — otherwise the selector returns a changing string and the header
  // re-renders on every keystroke even though hasAnyContent never changes.
  const hasAnyContent = useAppStore((s) => Boolean(s.rawData || s.propsConf || s.transformsConf));

  const { error: errorCount, warning: warningCount } = useMemo(() => countByLevel(diagnostics), [diagnostics]);

  const modifierName = getModifierName();

  return (
    <header
      className="flex flex-col shrink-0"
      style={{
        backgroundColor: 'var(--color-bg-secondary)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <div className="flex items-center justify-between px-4 h-12">
        <div className="flex items-center gap-2">
          <Icon name="sliders" className="w-5 h-5 shrink-0 text-[var(--color-accent)]" />
          <h1 className="text-sm font-bold tracking-wide" style={{ color: 'var(--color-text-primary)' }}>
            Propslab
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <ExamplesMenu />
          <Tooltip content={`Command palette (${modifierName}+K)`} side="bottom">
            {/* The name is the visible text, "Commands" and the shortcut (WCAG
                2.5.3, label in name), so a speech user who says what they see
                reaches it. It stays an aria-label because both spans are hidden
                on narrow screens, where the icon alone is shown. The space
                before the <kbd> keeps the two words apart for tools that read
                the text; the flex layout ignores it. */}
            <button
              onClick={toggleCommandPalette}
              aria-label={`Commands ${modifierName}K`}
              aria-keyshortcuts={isApplePlatform() ? 'Meta+K' : 'Control+K'}
              className="flex items-center gap-1.5 px-2 h-7 rounded-md text-xs border border-[var(--color-border-control)] cursor-pointer
                text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] press"
            >
              <Icon name="search" className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Commands</span>{' '}
              <kbd className="ml-1 px-1 rounded text-xs font-mono bg-[var(--color-bg-tertiary)] hidden sm:inline">
                {modifierName}K
              </kbd>
            </button>
          </Tooltip>
          {hasAnyContent && <ClearButton onClear={resetAll} label="Clear All" />}
          <PanelToggle
            tooltip="Settings"
            label="Open settings"
            icon="settings"
            open={settingsOpen}
            onClick={toggleSettings}
          />
          <PanelToggle
            tooltip="Pipeline reference"
            label="Open pipeline reference"
            icon="info"
            open={helpOpen}
            onClick={toggleHelp}
          />
          <ThemeToggle />
        </div>
      </div>
      {isProcessing && <ProgressBar label="Processing" />}
      {/* Screen-reader live region */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {errorCount > 0
          ? `${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warningCount} warning${warningCount !== 1 ? 's' : ''}`
          : warningCount > 0
            ? `${warningCount} warning${warningCount !== 1 ? 's' : ''}`
            : result
              ? 'Configuration valid'
              : ''}
      </div>
    </header>
  );
}
