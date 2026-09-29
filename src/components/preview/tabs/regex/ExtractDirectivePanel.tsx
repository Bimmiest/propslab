import { useId } from 'react';
import { copyToClipboard } from '../../../../utils/clipboard';
import { useApplyDirective } from '../shared/useApplyDirective';
import { classNameError } from './regexLogic';

/** The EXTRACT directive the pattern makes, with copy and add-to-props.conf. */
export function ExtractDirectivePanel({
  pattern, className, setClassName, block, copied: [copied, flashCopied], added: [added, flashAdded],
}: {
  pattern: string;
  className: string;
  setClassName: (value: string) => void;
  block: { reason: string | null; isError: boolean };
  /** The "Copied!" / "Added!" confirmations, owned by the tab so they outlive this panel. */
  copied: [boolean, () => void];
  added: [boolean, () => void];
}) {
  const matchBlockId = useId();
  const classErrorId = useId();
  const { stanza, isPlaceholderStanza, apply: applyDirective } = useApplyDirective();

  const extractDirective = `EXTRACT-${className} = ${pattern}`;
  const matchBlock = block.reason;
  const classError = classNameError(className);
  const canAdd = matchBlock === null && classError === null;
  const addDescribedBy = [matchBlock && matchBlockId, classError && classErrorId].filter(Boolean).join(' ') || undefined;

  /**
   * Write the directive straight into props.conf, closing the loop from
   * experiment to config. The match statistics beside it are whole-dataset,
   * so what is being committed to is visible at the moment of the click
   * rather than inferred from the current page.
   */
  const handleAddToProps = () => {
    if (!canAdd) return;
    applyDirective(`EXTRACT-${className}`, pattern);
    flashAdded();
  };

  // Use the shared helper so copying still works in insecure contexts where
  // navigator.clipboard is unavailable (it falls back to execCommand).
  // Settled rather than voided: a rejected copy must not flip the label to
  // "Copied!", and a floating rejection reaches the console (as CopyButton).
  const handleCopy = () => {
    copyToClipboard(extractDirective).then(flashCopied, () => {});
  };

  return (
    <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-1 mb-1">
        <span className="text-xs text-[var(--color-text-muted)]">EXTRACT-</span>
        <input
          type="text"
          aria-label="EXTRACT class name"
          value={className}
          onChange={(e) => setClassName(e.target.value.replace(/\s/g, '_'))}
          aria-invalid={classError !== null}
          aria-describedby={classError ? classErrorId : undefined}
          className="px-1.5 py-0.5 text-xs font-mono rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] w-32"
          placeholder="classname"
        />
      </div>
      {classError && (
        <div id={classErrorId} className="mb-1 text-[10px] text-[var(--color-error)]">{classError}</div>
      )}
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono px-2 py-1.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-success)] break-all select-all">
          {extractDirective}
        </code>
        <button
          onClick={handleCopy}
          className="flex-shrink-0 px-2 py-1 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
          title="Copy to clipboard"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button
          onClick={handleAddToProps}
          disabled={!canAdd}
          aria-describedby={addDescribedBy}
          className="flex-shrink-0 px-2 py-1 text-xs rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title={matchBlock ?? classError ?? `Upsert into [${stanza}] in props.conf`}
        >
          {added ? 'Added!' : 'Add to props.conf'}
        </button>
      </div>
      {matchBlock && (
        <p
          id={matchBlockId}
          className={`mt-1 text-[10px] ${block.isError ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'}`}
        >
          {matchBlock}
        </p>
      )}
      {/*
        Say what the button is about to do to the metadata. Writing
        [my:sourcetype] and silently repointing the event's sourcetype at it
        is the right behaviour but a surprising one to discover after
        the fact.
      */}
      {isPlaceholderStanza && (
        <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
          This event has no sourcetype. Adding writes <code>[{stanza}]</code> and sets the
          event&apos;s sourcetype to match, so the stanza applies.
        </p>
      )}
    </div>
  );
}
