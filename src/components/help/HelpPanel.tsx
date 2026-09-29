import { useEffect, useRef } from 'react';
import { Overlay } from '../ui/Overlay';
import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../ui/Icon';
import { PIPELINE_STAGES, PHASE_LABELS, type PipelineStage } from '../../engine/pipelineStages';
import { tint } from '../../utils/tint';

export function HelpPanel() {
  const helpOpen = useAppStore((s) => s.helpOpen);
  const toggleHelp = useAppStore((s) => s.toggleHelp);
  const openDictionaryAt = useAppStore((s) => s.openDictionaryAt);
  // In the store rather than local state so the dictionary's "Runs at" links
  // can open the drawer at a given stage (openHelpAt).
  const expandedStep = useAppStore((s) => s.helpStage);
  const setExpandedStep = useAppStore((s) => s.setHelpStage);

  // This drawer answers "what runs when"; the dictionary answers "what does
  // this directive do". Selecting a directive chip hands over to the other and
  // closes this one, so the two never fight for the same screen.
  const openDirective = (key: string) => {
    openDictionaryAt(key);
    toggleHelp();
  };


  const indexStages = PIPELINE_STAGES.filter((s) => s.phase === 'index-time');
  const searchStages = PIPELINE_STAGES.filter((s) => s.phase === 'search-time');

  return (
    // The slide is `drawer-slide`'s keyframes on Radix's data-state (index.css):
    // an exit animation is what Presence waits for before unmounting, where a
    // transition would be cut off by the unmount.
    <Overlay
      open={helpOpen}
      onClose={toggleHelp}
      label="Pipeline reference"
      containerClassName=""
      className="drawer-slide fixed top-0 right-0 bottom-0 z-50 flex flex-col w-[420px] max-w-full shadow-2xl"
      style={{
        backgroundColor: 'var(--color-bg-primary)',
        borderLeft: '1px solid var(--color-border)',
      }}
    >
      <div className="contents">
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 shrink-0 border-b"
          style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-secondary)' }}
        >
          <div className="flex items-center gap-2">
            <Icon name="settings" className="w-4 h-4 text-[var(--color-accent)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Pipeline Reference</h2>
          </div>
          <button
            onClick={toggleHelp}
            aria-label="Close panel"
            className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors border-none bg-transparent cursor-pointer"
          >
            <Icon name="x" className="w-4 h-4" />
          </button>
        </div>

        {/* Intro */}
        <div className="px-5 py-3 shrink-0 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
            Splunk processes events in a fixed order. Index-time processors run when data is ingested;
            search-time processors run at query time. Click any stage to see which directives control it.
          </p>
        </div>

        {/* Stages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          <StageGroup
            title="Index-Time Processing"
            stages={indexStages}
            phaseColor="var(--color-warning)"
            expandedStep={expandedStep}
            onToggle={setExpandedStep}
            onOpenDirective={openDirective}
          />
          <StageGroup
            title="Search-Time Processing"
            stages={searchStages}
            phaseColor="var(--color-accent)"
            expandedStep={expandedStep}
            onToggle={setExpandedStep}
            onOpenDirective={openDirective}
          />
        </div>

        {/* Footer */}
        <div
          className="px-5 py-3 shrink-0 border-t text-xs text-[var(--color-text-muted)]"
          style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-secondary)' }}
        >
          <p>Select a directive to look it up in the dictionary, or hover any key in the editor.</p>
          {/* The one place in the UI that states the obvious out loud: this is
              a simulator someone wrote, not something Splunk publishes. It sits
              here rather than in the header because it needs room for a
              sentence, and this drawer is where a user goes to ask what the
              tool is. */}
          <p className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
            Propslab is an independent project, not affiliated with or endorsed by Splunk Inc.
            Splunk is a registered trademark of Splunk Inc.
          </p>
        </div>
      </div>
    </Overlay>
  );
}

function StageGroup({
  title,
  stages,
  phaseColor,
  expandedStep,
  onToggle,
  onOpenDirective,
}: {
  title: string;
  stages: PipelineStage[];
  phaseColor: string;
  expandedStep: number | null;
  onToggle: (step: number | null) => void;
  onOpenDirective: (key: string) => void;
}) {
  return (
    <div>
      <p
        className="text-[11px] font-semibold uppercase tracking-wider mb-2"
        style={{ color: phaseColor }}
      >
        {title}
      </p>
      <div className="space-y-1.5">
        {stages.map((stage) => (
          <StageCard
            key={stage.step}
            stage={stage}
            phaseColor={phaseColor}
            isExpanded={expandedStep === stage.step}
            onToggle={() => onToggle(expandedStep === stage.step ? null : stage.step)}
            onOpenDirective={onOpenDirective}
          />
        ))}
      </div>
    </div>
  );
}

function StageCard({
  stage,
  phaseColor,
  isExpanded,
  onToggle,
  onOpenDirective,
}: {
  stage: PipelineStage;
  phaseColor: string;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenDirective: (key: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A stage opened from the dictionary may sit below the fold.
  useEffect(() => {
    if (isExpanded) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [isExpanded]);

  return (
    <div
      ref={ref}
      className="rounded-lg border overflow-hidden transition-colors"
      style={{
        borderColor: isExpanded ? tint(phaseColor, 38) : 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-bg-elevated)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left cursor-pointer bg-transparent border-none transition-colors hover:bg-[var(--color-bg-secondary)]"
      >
        {/* Step badge */}
        <div
          className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
          style={{ backgroundColor: tint(phaseColor, 13), color: phaseColor }}
        >
          {stage.step}
        </div>

        <div className="flex-1 min-w-0">
          <span className="text-xs font-semibold text-[var(--color-text-primary)]">{stage.name}</span>
          <span
            className="ml-2 text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{ backgroundColor: tint(phaseColor, 8), color: phaseColor }}
          >
            {PHASE_LABELS[stage.phase]}
          </span>
        </div>

        <Icon
          name="chevron-down"
          className={`shrink-0 w-3.5 h-3.5 text-[var(--color-text-muted)] transition-transform duration-150 ${isExpanded ? '' : '-rotate-90'}`}
        />
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed mb-3">
            {stage.description}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {stage.directives.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onOpenDirective(d)}
                title={`Open ${d} in the dictionary`}
                className="px-2 py-0.5 text-[11px] font-mono rounded-md font-medium cursor-pointer
                  outline-none focus-visible:ring-2 transition-colors hover:bg-[var(--color-bg-tertiary)]"
                style={{
                  backgroundColor: 'var(--color-bg-secondary)',
                  color: 'var(--color-accent)',
                  border: '1px solid var(--color-border)',
                }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
