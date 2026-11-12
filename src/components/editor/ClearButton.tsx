import { useState, useCallback, useEffect } from 'react';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';

/** Icon only in a pane narrower than 20rem, where the text pushed into the pane's title. */
export const PANE_LABEL = 'whitespace-nowrap @max-xs:hidden';

interface ClearButtonProps {
  onClear: () => void;
  label?: string;
  /**
   * Hides the visible text in a narrow container (#893); the accessible name
   * and the tooltip keep it. The default suits a pane header with `@container`.
   */
  labelClassName?: string;
}

export function ClearButton({ onClear, label = 'Clear', labelClassName = PANE_LABEL }: ClearButtonProps) {
  const [confirming, setConfirming] = useState(false);

  // Auto-cancel confirm state after 3 s if user doesn't click again
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const handleClick = useCallback(() => {
    if (confirming) {
      onClear();
      setConfirming(false);
    } else {
      setConfirming(true);
    }
  }, [confirming, onClear]);

  return (
    <Tooltip content={confirming ? 'Click again to confirm' : label} side="bottom">
      <button
        onClick={handleClick}
        onBlur={() => setConfirming(false)}
        className={[
          'shrink-0 flex items-center gap-1 px-2 py-1 text-xs rounded press',
          confirming
            ? 'bg-[var(--color-error)] text-[var(--color-text-on-error)]'
            : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-error)] hover:text-[var(--color-text-on-error)]',
        ].join(' ')}
        aria-label={confirming ? 'Click again to confirm clear' : label}
      >
        <Icon name="x" className="w-3.5 h-3.5 shrink-0" />
        <span className={labelClassName}>{confirming ? 'Sure?' : label}</span>
      </button>
    </Tooltip>
  );
}
