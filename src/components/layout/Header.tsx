import { useMemo } from 'react';
import { useAppStore, EMPTY_INPUTS } from '../../store/useAppStore';
import { ThemeToggle } from '../ui/ThemeToggle';
import { ProgressBar } from '../ui/ProgressBar';
import { Icon, type IconName } from '../ui/Icon';
import { ClearButton } from '../editor/ClearButton';
import { Tooltip } from '../ui/Tooltip';

/** Detect whether the platform is Apple (Mac, iOS, iPad, etc.). */
function isApplePlatform(): boolean {
  try {
    // Modern API, available in recent browsers
    const platform = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform;
    if (platform?.toLowerCase().includes('mac')) {
      return true;
    }
  } catch {
    // Fallback if userAgentData is not available
  }
  // Fallback: check navigator.platform for older browsers
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the fallback for older browsers
  return /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform);
}

/** Get the keyboard modifier name for the current platform. */
function getModifierName(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}

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
          'focus-visible:ring-2 transition-colors cursor-pointer',
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

  const errorCount = useMemo(() => diagnostics.filter((d) => d.level === 'error').length, [diagnostics]);
  const warningCount = useMemo(() => diagnostics.filter((d) => d.level === 'warning').length, [diagnostics]);

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
          <Tooltip content={`Command palette (${modifierName}+K)`} side="bottom">
            <button
              onClick={toggleCommandPalette}
              aria-label="Open command palette"
              className="flex items-center gap-1.5 px-2 h-7 rounded-md text-[11px] border border-[var(--color-border)] cursor-pointer
                text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            >
              <Icon name="search" className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Commands</span>
              <kbd className="ml-1 px-1 rounded text-[10px] font-mono bg-[var(--color-bg-tertiary)] hidden sm:inline">
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
