import { useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';

const MAIN_THREAD_HINT =
  'No pipeline worker could be loaded, so the pipeline runs on the main thread. ' +
  'There is no watchdog here: a runaway regex freezes the tab instead of being stopped. ' +
  'Reload the page to try the worker again.';

/** Where the pipeline runs and whether it is busy. */
function WorkerState() {
  const result = useAppStore((s) => s.processingResult);
  const isProcessing = useAppStore((s) => s.isProcessing);
  const onMainThread = useAppStore((s) => s.pipelineOnMainThread);

  const color = isProcessing
    ? 'var(--color-accent)'
    : onMainThread
      ? 'var(--color-warning)'
      : result
        ? 'var(--color-success)'
        : 'var(--color-text-muted)';
  const dot = <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />;

  // After a worker load failure the pipeline runs inline (#403): say so
  // rather than "Worker idle", in words and to a screen reader.
  if (onMainThread) {
    return (
      <Tooltip content={MAIN_THREAD_HINT} side="top">
        <span className="flex items-center gap-1.5 cursor-help" tabIndex={0} data-testid="pipeline-main-thread">
          {dot}
          {isProcessing ? 'Processing on main thread…' : 'Main thread (no watchdog)'}
          <span className="sr-only">. {MAIN_THREAD_HINT}</span>
        </span>
      </Tooltip>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      {dot}
      {isProcessing ? 'Processing…' : result ? 'Worker idle' : 'Ready'}
    </span>
  );
}

/** Left: worker status + timing + manual-run controls */
function PipelineStatus() {
  const isProcessing = useAppStore((s) => s.isProcessing);
  const lastProcessingMs = useAppStore((s) => s.lastProcessingMs);
  const settings = useAppStore((s) => s.settings);
  const pipelineDirty = useAppStore((s) => s.pipelineDirty);
  const triggerManualRun = useAppStore((s) => s.triggerManualRun);
  const toggleSettings = useAppStore((s) => s.toggleSettings);

  const timingLabel = lastProcessingMs !== null
    ? lastProcessingMs < 1000
      ? `${Math.round(lastProcessingMs)}ms`
      : `${(lastProcessingMs / 1000).toFixed(1)}s`
    : null;

  return (
    <div className="flex items-center gap-3">
      <WorkerState />
      {timingLabel && !isProcessing && (
        <span>{timingLabel}</span>
      )}
      {settings.perEventPipeline && (
        <Tooltip
          content="Per-event pipeline is on — events that rewrite metadata via DEST_KEY = MetaData:* will re-match stanzas and may use different search-time directives. Click to open Settings."
          side="top"
        >
          <button
            onClick={toggleSettings}
            className="flex items-center gap-1 px-1.5 h-4 rounded text-[10px] font-medium border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-text-on-accent)] transition-colors cursor-pointer bg-transparent"
          >
            Per-event pipeline
          </button>
        </Tooltip>
      )}
      {settings.manualApply && (
        <span className="flex items-center gap-1.5">
          {pipelineDirty && !isProcessing && (
            <span style={{ color: 'var(--color-warning)' }}>● Out of date</span>
          )}
          <Tooltip content="Run pipeline (applies current config)" side="top">
            <button
              onClick={triggerManualRun}
              disabled={isProcessing}
              aria-label="Run pipeline"
              className={[
                'flex items-center gap-1 px-2 h-5 rounded text-[10px] font-medium border transition-colors cursor-pointer',
                isProcessing
                  ? 'opacity-40 cursor-not-allowed border-[var(--color-border)] text-[var(--color-text-muted)]'
                  : pipelineDirty
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-text-on-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]',
              ].join(' ')}
            >
              <Icon name="play" className="w-2.5 h-2.5" />
              Run
            </button>
          </Tooltip>
        </span>
      )}
    </div>
  );
}

/** Right: events / fields / diagnostics */
function ResultSummary() {
  const result = useAppStore((s) => s.processingResult);
  const diagnostics = useAppStore((s) => s.validationDiagnostics);

  const fieldCount = useMemo(() => {
    if (!result) return 0;
    const fieldSet = new Set<string>();
    for (const event of result.events) {
      for (const key of Object.keys(event.fields)) fieldSet.add(key);
    }
    return fieldSet.size;
  }, [result]);

  const errorCount = useMemo(() => diagnostics.filter((d) => d.level === 'error').length, [diagnostics]);
  const warningCount = useMemo(() => diagnostics.filter((d) => d.level === 'warning').length, [diagnostics]);

  return (
    <div className="flex items-center gap-3">
      {result && (
        <>
          <span>{result.eventCount} event{result.eventCount !== 1 ? 's' : ''}</span>
          <span>{fieldCount} field{fieldCount !== 1 ? 's' : ''}</span>
        </>
      )}
      {errorCount > 0 && (
        <span style={{ color: 'var(--color-error)' }}>{errorCount} error{errorCount !== 1 ? 's' : ''}</span>
      )}
      {warningCount > 0 && (
        <span style={{ color: 'var(--color-warning)' }}>{warningCount} warning{warningCount !== 1 ? 's' : ''}</span>
      )}
      {result && errorCount === 0 && warningCount === 0 && (
        <span style={{ color: 'var(--color-success)' }}>✓ Valid</span>
      )}
      {/* Last, and muted: a bug report needs to be able to name the build it
          came from, but the version is not something a user is looking for. */}
      <span style={{ color: 'var(--color-text-muted)' }} title={`Propslab ${__APP_VERSION__}`}>
        v{__APP_VERSION__}
      </span>
    </div>
  );
}

export function StatusBar() {
  return (
    // A <footer>, so the bar is a contentinfo landmark rather than stray
    // content outside every landmark (axe `region`).
    <footer
      className="flex items-center justify-between px-4 h-6 shrink-0 text-[11px] select-none"
      style={{
        backgroundColor: 'var(--color-bg-secondary)',
        borderTop: '1px solid var(--color-border)',
        color: 'var(--color-text-muted)',
      }}
    >
      <PipelineStatus />
      <ResultSummary />
    </footer>
  );
}
