import { useCallback, useState, type ReactNode } from 'react';
import { useAppStore, selectSessionDirty, type SessionInputs } from '../../store/useAppStore';
import { ConfirmDialog } from './ConfirmDialog';

interface PendingReplace {
  inputs: SessionInputs;
  confirmLabel: string;
  what: string;
}

/**
 * Replace all four inputs at once (an example, or empty ones), asking first
 * when that would lose edits. `replace` answers true when it loaded, false when
 * it is asking; render `confirm` for the question. The session is read when
 * asked, not subscribed to, so the caller does not re-render on every
 * keystroke in an editor.
 */
export function useReplaceInputs(): {
  replace: (inputs: SessionInputs, confirmLabel: string, what: string) => boolean;
  confirm: ReactNode;
} {
  const loadInputs = useAppStore((s) => s.loadInputs);
  const [pending, setPending] = useState<PendingReplace | null>(null);

  const replace = useCallback(
    (inputs: SessionInputs, confirmLabel: string, what: string) => {
      if (selectSessionDirty(useAppStore.getState())) {
        setPending({ inputs, confirmLabel, what });
        return false;
      }
      loadInputs(inputs);
      return true;
    },
    [loadInputs],
  );

  const confirm = pending && (
    <ConfirmDialog
      open
      title="Replace your current work?"
      confirmLabel={pending.confirmLabel}
      onConfirm={() => {
        loadInputs(pending.inputs);
        setPending(null);
      }}
      onCancel={() => setPending(null)}
    >
      {pending.what} replaces the raw data, props.conf, transforms.conf and metadata you have now. Your changes are not
      saved anywhere else.
    </ConfirmDialog>
  );

  return { replace, confirm };
}
