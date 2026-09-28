import { useEffect, useRef, useState, type ReactNode } from 'react';
import { timePrefixFromSelection } from '../../../../engine/scaffold/fromSelection';
import { DirectiveDialog } from './DirectiveDialog';
import { useLiveCapture, isSettledCapture, type Capture } from './useLiveCapture';

/**
 * In-app dialog for "Set as TIME_PREFIX from selection" (replaces a window.alert
 * dead-end). Pre-fills the editable field with the stable literal that precedes the
 * selected timestamp when one can be derived, and always shows the preceding text so
 * the user can craft/adjust the prefix even when auto-derivation finds no boundary.
 */
export function TimePrefixDialog({
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
  onApply: (value: string) => void;
  onClose: () => void;
}) {
  // Best-effort default from the shared, tested helper (may be null at the start of
  // the event or when no stable boundary precedes the selection).
  const [value, setValue] = useState(() => timePrefixFromSelection(raw, selection, selectionStart) ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const idx = selectionStart !== undefined && selectionStart >= 0 ? selectionStart : raw.indexOf(selection);
  const before = idx > 0 ? raw.slice(0, idx) : '';
  const contextHint = before.slice(-32);

  const trimmed = value.trim();
  // The same gate as ExtractNameDialog: TIME_PREFIX is a user regex too, and
  // one that does not compile, or backtracks past the watchdog, must not reach
  // props.conf, where it would run against every event.
  const capture = useLiveCapture(raw, trimmed);
  const valid = isSettledCapture(capture);

  return (
    <DirectiveDialog
      title="Set TIME_PREFIX from selection"
      applyLabel="Set TIME_PREFIX"
      applyDisabled={!valid}
      onApply={() => { if (valid) { onApply(trimmed); onClose(); } }}
      onClose={onClose}
    >
      <div>
        <label htmlFor="time-prefix-value" className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-secondary)' }}>
          TIME_PREFIX <span className="font-normal normal-case">(regex matching the text before the timestamp)</span>
        </label>
        <input
          id="time-prefix-value"
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          placeholder="e.g. \["
          className="mt-1 w-full px-2.5 py-1.5 rounded-md text-sm font-mono outline-none bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] border border-[var(--color-border)] focus:border-[var(--color-accent)]"
        />
      </div>

      <PrefixMatchNote capture={capture} />

      {contextHint && (
        <div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
          Text before the selection:{' '}
          <code className="font-mono px-1 rounded" style={{ backgroundColor: 'var(--color-bg-tertiary)' }}>
            …{contextHint}
          </code>
        </div>
      )}

      <div>
        <div className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          Adds to <code className="font-mono">[{stanza}]</code>
        </div>
        <pre
          className="text-xs font-mono rounded border p-2 overflow-x-auto whitespace-pre-wrap break-all"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)', backgroundColor: 'var(--color-bg-secondary)' }}
        >
          {trimmed ? `TIME_PREFIX = ${trimmed}` : 'Enter the text that precedes the timestamp…'}
        </pre>
      </div>
    </DirectiveDialog>
  );
}

function PrefixMatchNote({ capture }: { capture: Capture }) {
  if (capture.state === 'empty') return null;
  const note = (color: string, text: ReactNode) => (
    <div className="text-xs font-medium" style={{ color }}>{text}</div>
  );
  if (capture.state === 'invalid') return note('var(--color-error)', capture.reason ?? "Invalid regex — won't compile");
  if (capture.state === 'timeout') {
    return note(
      'var(--color-error)',
      'Pattern took too long to run — it likely backtracks catastrophically. Simplify it before setting it.',
    );
  }
  if (capture.state === 'pending') return note('var(--color-text-muted)', 'Matching…');
  if (capture.state === 'nomatch') {
    return note('var(--color-warning)', 'No match in this event — the timestamp would not be found here');
  }
  return note(
    'var(--color-success)',
    <>Matches <span className="font-mono" style={{ color: 'var(--color-text-primary)' }}>{capture.full}</span></>,
  );
}
