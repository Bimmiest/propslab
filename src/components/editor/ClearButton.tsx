import { useState, useCallback, useEffect } from 'react';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';

interface ClearButtonProps {
  onClear: () => void;
  label?: string;
}

export function ClearButton({ onClear, label = 'Clear' }: ClearButtonProps) {
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
          'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors',
          confirming
            ? 'bg-[var(--color-error)] text-[var(--color-text-on-error)]'
            : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-error)] hover:text-[var(--color-text-on-error)]',
        ].join(' ')}
        aria-label={confirming ? 'Click again to confirm clear' : label}
      >
        <Icon name="x" className="w-3.5 h-3.5" />
        {confirming ? 'Sure?' : label}
      </button>
    </Tooltip>
  );
}
