import { useEffect, useRef, useState } from 'react';
import { buildExtractFromSelection, toCaptureGroupName } from '../../../../engine/scaffold/fromSelection';
import { DirectiveDialog } from './DirectiveDialog';
import { useLiveCapture, isSettledCapture, type Capture } from './useLiveCapture';

/**
 * In-app dialog for "Create EXTRACT from selection". The field name and the regex
 * pattern are both editable; the pattern stays derived from the field name until the
 * user edits it directly. A live capture runs the pattern against this event's raw
 * in the regex-match worker, behind its watchdog, so you can see exactly what it
 * grabs before applying; Add stays disabled until that capture has settled.
 */
export function ExtractNameDialog({
  raw,
  selection,
  selectionStart,
  stanza,
  onApply,
  onClose,
}: {
  raw: string;
  selection: string;
  selectionStart?: number;
  stanza: string;
  onApply: (key: string, value: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('new_field');
  const [pattern, setPattern] = useState(() => buildExtractFromSelection(raw, selection, 'new_field', selectionStart)?.value ?? '');
  const [patternDirty, setPatternDirty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const onNameChange = (v: string) => {
    setName(v);
    // Keep the generated pattern (and its named group) in sync until the user takes
    // manual control of the regex.
    if (!patternDirty) {
      const regen = buildExtractFromSelection(raw, selection, v, selectionStart);
      setPattern(regen?.value ?? '');
    }
  };

  // The capture-group name (and thus the extracted field) must be a valid
  // identifier — hyphens/dots/leading digits get sanitised. Surface that so the
  // user isn't surprised the applied field name differs from what they typed.
  const cleanName = toCaptureGroupName(name);
  const nameAdjusted = name.trim() !== '' && cleanName !== name.trim();

  const trimmed = pattern.trim();
  const capture = useLiveCapture(raw, trimmed);

  // Adding needs a settled 'ok' run of exactly this pattern. While matching is
  // pending the pattern may not have compiled yet, or may still be inside the
  // watchdog window — a catastrophic regex could reach props.conf before the
  // timeout that would flag it. A timeout keeps the button disabled: the pipeline would
  // hit the same wall on every event this stanza applies to.
  const valid = isSettledCapture(capture);

  return (
    <DirectiveDialog
      title="Create EXTRACT from selection"
      applyLabel="Add EXTRACT"
      applyDisabled={!valid}
      onApply={() => { if (valid) { onApply(`EXTRACT-${cleanName}`, trimmed); onClose(); } }}
      onClose={onClose}
    >
      <div>
        <label htmlFor="extract-field-name" className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-secondary)' }}>
          Field name
        </label>
        <input
          id="extract-field-name"
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          spellCheck={false}
          className="mt-1 w-full px-2.5 py-1.5 rounded-md text-sm font-mono outline-none bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] border border-[var(--color-border)] focus:border-[var(--color-accent)]"
        />
        {nameAdjusted && (
          <div className="mt-1 text-xs" style={{ color: 'var(--color-warning)' }}>
            Field will be named <code className="font-mono">{cleanName}</code> — capture groups allow only letters, digits, and <code className="font-mono">_</code>.
          </div>
        )}
      </div>

      <div>
        <label htmlFor="extract-pattern" className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-secondary)' }}>
          Regex
        </label>
        <input
          id="extract-pattern"
          type="text"
          value={pattern}
          onChange={(e) => { setPattern(e.target.value); setPatternDirty(true); }}
          spellCheck={false}
          className="mt-1 w-full px-2.5 py-1.5 rounded-md text-sm font-mono outline-none bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] border border-[var(--color-border)] focus:border-[var(--color-accent)]"
        />
      </div>

      <CapturePreview capture={capture} />

      <div>
        <div className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          Adds to <code className="font-mono">[{stanza}]</code>
        </div>
        <pre
          className="text-xs font-mono rounded border p-2 overflow-x-auto whitespace-pre-wrap break-all"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)', backgroundColor: 'var(--color-bg-secondary)' }}
        >
          {trimmed ? `EXTRACT-${cleanName} = ${trimmed}` : 'Enter a regex…'}
        </pre>
      </div>
    </DirectiveDialog>
  );
}

function CapturePreview({ capture }: { capture: Capture }) {
  if (capture.state === 'empty') return null;

  const note = (color: string, text: string) => (
    <div className="text-xs font-medium" style={{ color }}>{text}</div>
  );

  if (capture.state === 'invalid') {
    return note('var(--color-error)', capture.reason ?? "Invalid regex — won't compile");
  }
  if (capture.state === 'timeout') {
    return note(
      'var(--color-error)',
      'Pattern took too long to run — it likely backtracks catastrophically. Simplify it before adding it.',
    );
  }
  if (capture.state === 'pending') return note('var(--color-text-muted)', 'Matching…');
  if (capture.state === 'nomatch') return note('var(--color-warning)', 'No match in this event');
  if (capture.state === 'nogroup') {
    return (
      <div className="text-xs" style={{ color: 'var(--color-warning)' }}>
        Matches <span className="font-mono" style={{ color: 'var(--color-text-primary)' }}>{capture.full}</span>, but has no named group — add <span className="font-mono">(?&lt;name&gt;…)</span>
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-secondary)' }}>
        Captures in this event
      </div>
      <div className="flex flex-wrap gap-1.5">
        {capture.groups.map(([k, v]) => (
          <span key={k} className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)' }}>
            <span style={{ color: 'var(--color-success)' }}>{k}</span>
            <span style={{ color: 'var(--color-text-muted)' }}> = </span>
            {v === '' ? <span style={{ color: 'var(--color-text-muted)' }}>(empty)</span> : v}
          </span>
        ))}
      </div>
    </div>
  );
}
