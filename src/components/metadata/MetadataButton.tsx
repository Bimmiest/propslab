// ---------------------------------------------------------------------------
// MetadataButton.tsx
// The events' metadata (index, host, source, sourcetype) in a dialog, opened
// from the Raw Log header (#693), so the four fields do not take the raw log
// editor's height. The button shows the sourcetype, because it picks the
// [stanza] that applies.
// ---------------------------------------------------------------------------

import { useState, type KeyboardEvent } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { EventMetadata } from '../../engine/types';
import { DialogButton, DialogFooter, DialogFrame, DialogHeader } from '../ui/DialogFrame';
import { Icon } from '../ui/Icon';

const metadataFields: { key: keyof EventMetadata; label: string; hint: string }[] = [
  { key: 'index', label: 'index', hint: 'Splunk index where the event is stored' },
  { key: 'host', label: 'host', hint: 'Matches host:: stanzas in props.conf' },
  { key: 'source', label: 'source', hint: 'Matches source:: stanzas in props.conf' },
  {
    key: 'sourcetype',
    label: 'sourcetype',
    hint: 'Matches [sourcetype] stanzas in props.conf — the most important field for pipeline matching',
  },
];

export function MetadataButton() {
  const metadata = useAppStore((s) => s.metadata);
  const setMetadataField = useAppStore((s) => s.setMetadataField);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  // The fields write to the store as you type, so Enter in one closes the
  // dialog as Done does. Not on a button, whose own activation it is.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.target instanceof HTMLElement && e.target.closest('button')) return;
    e.preventDefault();
    close();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Index, host, source and sourcetype of the events"
        className="flex items-center gap-1 min-w-0 px-2 py-0.5 rounded text-[11px] font-medium cursor-pointer border-none text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        <Icon name="tag" className="w-3.5 h-3.5 shrink-0 text-[var(--color-accent)]" />
        Metadata
        {/* The space keeps "Metadata" and the sourcetype two words in the button's name. */}
        {metadata.sourcetype && ' '}
        {metadata.sourcetype && (
          <span className="font-mono font-normal truncate max-w-[12rem] text-[var(--color-text-muted)]">
            {metadata.sourcetype}
          </span>
        )}
      </button>
      <DialogFrame
        open={open}
        onClose={close}
        label="Metadata"
        onKeyDown={onKeyDown}
        header={<DialogHeader icon="tag" iconClassName="text-[var(--color-accent)]" title="Metadata" titleHidden />}
        footer={
          <DialogFooter>
            <DialogButton variant="accent" onClick={close}>
              Done
            </DialogButton>
          </DialogFooter>
        }
      >
        <div className="p-4 space-y-3">
          {metadataFields.map(({ key, label, hint }) => (
            <div key={key}>
              <label
                htmlFor={`metadata-${key}`}
                className="text-xs font-semibold uppercase tracking-wider"
                // sourcetype drives [stanza] matching — emphasise it over the others.
                style={{ color: key === 'sourcetype' ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}
              >
                {label}
              </label>
              <input
                id={`metadata-${key}`}
                type="text"
                value={metadata[key]}
                onChange={(e) => setMetadataField(key, e.target.value)}
                placeholder={key === 'index' ? 'main' : key}
                spellCheck={false}
                aria-describedby={`metadata-${key}-hint`}
                className="mt-1 w-full px-2.5 py-1.5 rounded-md text-sm font-mono outline-none bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] border border-[var(--color-border-control)] focus:border-[var(--color-accent)]"
              />
              <p id={`metadata-${key}-hint`} className="text-xs mt-1 text-[var(--color-text-muted)]">
                {hint}
              </p>
            </div>
          ))}
        </div>
      </DialogFrame>
    </>
  );
}
