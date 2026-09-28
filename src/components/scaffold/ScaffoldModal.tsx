import { useMemo, useState } from 'react';
import { Overlay } from '../ui/Overlay';
import { useAppStore } from '../../store/useAppStore';
import { scaffoldConfig } from '../../engine/scaffold/scaffoldConfig';
import { renderStanza, appendStanza, stanzaNameError } from '../../engine/scaffold/serialize';
import type { Confidence, ScaffoldSuggestion } from '../../engine/scaffold/types';

type ScaffoldResult = ReturnType<typeof scaffoldConfig>;
import { computeDiff } from '../../utils/diffEngine';
import { escapeRegex } from '../../utils/splunkRegex';
import { Icon } from '../ui/Icon';
import { DiffLines } from '../ui/DiffLines';
import { Badge } from '../ui/Badge';

const CONFIDENCE_VARIANT: Record<Confidence, 'success' | 'warning' | 'info'> = {
  high: 'success',
  medium: 'warning',
  low: 'info',
};

export function ScaffoldModal() {
  const toggleScaffold = useAppStore((s) => s.toggleScaffold);
  const rawData = useAppStore((s) => s.rawData);
  const metadata = useAppStore((s) => s.metadata);
  const propsConf = useAppStore((s) => s.propsConf);
  const setPropsConf = useAppStore((s) => s.setPropsConf);
  const setMetadataField = useAppStore((s) => s.setMetadataField);

  const noData = rawData.trim().length === 0;

  // Computed once per mount — the overlay blocks input editing while open, so the
  // sample is a point-in-time snapshot. (Mounted only while open; see AppShell.)
  const result = useMemo(() => scaffoldConfig(rawData, metadata), [rawData, metadata]);

  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const s of result.suggestions) init[s.key] = s.enabledByDefault;
    return init;
  });
  // Editable stanza name / sourcetype. Defaults to the normalised suggestion, the
  // current sourcetype, or a placeholder — and is written to metadata on apply so
  // the appended stanza actually matches the events.
  const [sourcetype, setSourcetype] = useState(() => result.sourcetype);

  const stanzaName = sourcetype.trim() || 'my:sourcetype';

  const chosen: ScaffoldSuggestion[] = result.suggestions.filter((s) => selected[s.key]);
  const mergedProps = chosen.length > 0 ? appendStanza(propsConf, renderStanza(stanzaName, chosen)) : propsConf;
  const diff = computeDiff(propsConf, mergedProps);
  const stanzaExists = new RegExp(`^[ \\t]*\\[${escapeRegex(stanzaName)}\\][ \\t]*$`, 'm').test(propsConf);

  // A name that cannot be written as a header must block Apply, not silently
  // produce a malformed props.conf (`foo]bar` → `[foo]bar]`).
  const nameError = stanzaNameError(stanzaName);
  const canApply = chosen.length > 0 && nameError === null;

  const apply = () => {
    if (!canApply) return;
    setPropsConf(mergedProps);
    // Point the event's sourcetype at the new stanza so the scaffolded config applies.
    if (stanzaName !== metadata.sourcetype) setMetadataField('sourcetype', stanzaName);
    toggleScaffold();
  };

  return (
    <Overlay
      open
      onClose={toggleScaffold}
      label="Scaffold configuration"
      containerClassName="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4"
      className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-xl overflow-hidden shadow-2xl"
      style={{ backgroundColor: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
    >
      <div className="contents">
        {/* Header */}
        <ScaffoldHeader onClose={toggleScaffold} />

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {noData ? (
            <EmptyState text="Paste raw log data first, then reopen Scaffold." />
          ) : result.suggestions.length === 0 ? (
            <EmptyState text="No confident suggestions for this sample. Try a larger or more representative sample." />
          ) : (
            <>
              {/* Sourcetype / stanza name (editable; written to metadata on apply) */}
              <StanzaNameField sourcetype={sourcetype} setSourcetype={setSourcetype} nameError={nameError} suggestion={result.sourcetypeSuggestion} />

              <div className="space-y-1.5">
                {result.suggestions.map((s) => (
                  <SuggestionRow
                    key={s.key}
                    suggestion={s}
                    checked={!!selected[s.key]}
                    onToggle={() => setSelected((prev) => ({ ...prev, [s.key]: !prev[s.key] }))}
                  />
                ))}
              </div>

              {stanzaExists && chosen.length > 0 && (
                <ExistingStanzaWarning stanzaName={stanzaName} />
              )}

              {/* Diff preview */}
              <ScaffoldDiffPreview stanzaName={stanzaName} diff={diff} />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 shrink-0" style={{ borderTop: '1px solid var(--color-border)' }}>
          <button
            onClick={toggleScaffold}
            className="px-3 py-1.5 text-sm rounded-md cursor-pointer border-none text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={!canApply}
            className="px-3 py-1.5 text-sm rounded-md cursor-pointer border-none font-medium text-[var(--color-text-on-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--color-accent)' }}
          >
            Append to props.conf
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function SuggestionRow({ suggestion, checked, onToggle }: { suggestion: ScaffoldSuggestion; checked: boolean; onToggle: () => void }) {
  return (
    <label
      className="flex items-start gap-3 px-3 py-2 rounded-lg cursor-pointer"
      style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border-subtle)' }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-0.5 accent-[var(--color-accent)] cursor-pointer" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="font-mono text-[13px]" style={{ color: 'var(--color-text-primary)' }}>
            {suggestion.key} = {suggestion.value}
          </code>
          <Badge variant={CONFIDENCE_VARIANT[suggestion.confidence]}>{suggestion.confidence}</Badge>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{suggestion.evidence}</p>
      </div>
    </label>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <Icon name="sparkles" className="w-8 h-8 text-[var(--color-border)]" />
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{text}</p>
    </div>
  );
}

function ScaffoldDiffPreview({ stanzaName, diff }: { stanzaName: string; diff: ReturnType<typeof computeDiff> }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
        props.conf preview — stanza <code className="font-mono">[{stanzaName}]</code>
      </div>
      <div className="rounded border text-xs font-mono leading-relaxed overflow-x-auto" style={{ borderColor: 'var(--color-border)' }}>
        <DiffLines diff={diff} />
      </div>
    </div>
  );
}

function ExistingStanzaWarning({ stanzaName }: { stanzaName: string }) {
  return (
    <div
      className="flex items-start gap-2 px-3 py-2 rounded-md text-xs"
      style={{ backgroundColor: 'rgba(245, 158, 11, 0.12)', color: 'var(--color-warning)' }}
    >
      <Icon name="warning" className="w-4 h-4 shrink-0 mt-0.5" />
      <span>
        A <code className="font-mono">[{stanzaName}]</code> stanza already exists in props.conf — these directives
        will be appended as a <strong>second</strong> stanza. Consider merging them into the existing one.
      </span>
    </div>
  );
}

function StanzaNameField({ sourcetype, setSourcetype, nameError, suggestion }: {
  sourcetype: string;
  setSourcetype: (value: string) => void;
  nameError: string | null;
  suggestion: ScaffoldResult['sourcetypeSuggestion'];
}) {
  return (
    <div>
      <label htmlFor="scaffold-sourcetype" className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-secondary)' }}>
        Sourcetype (stanza name)
      </label>
      <input
        id="scaffold-sourcetype"
        type="text"
        value={sourcetype}
        onChange={(e) => setSourcetype(e.target.value)}
        spellCheck={false}
        placeholder="my:sourcetype"
        className="mt-1 w-full px-2.5 py-1.5 rounded-md text-sm font-mono outline-none focus:border-[var(--color-border-hover)]"
        style={{ backgroundColor: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
      />
      {nameError ? (
        <p className="text-xs mt-1 font-medium" style={{ color: 'var(--color-error)' }}>
          {nameError}
        </p>
      ) : (
        <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
          {suggestion
            ? `${suggestion.evidence} — applied to the event's sourcetype on save`
            : "Applied to the event's sourcetype on save so the new stanza matches your data."}
        </p>
      )}
    </div>
  );
}

function ScaffoldHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 h-12 shrink-0" style={{ borderBottom: '1px solid var(--color-border)' }}>
      <Icon name="sparkles" className="w-4 h-4 text-[var(--color-accent)]" />
      <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Scaffold props.conf
      </span>
      <span className="text-xs ml-1" style={{ color: 'var(--color-text-muted)' }}>
        suggestions from your sample data — review and apply
      </span>
      <button
        onClick={onClose}
        aria-label="Close"
        className="ml-auto flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer border-none"
      >
        <Icon name="x" className="w-4 h-4" />
      </button>
    </div>
  );
}

