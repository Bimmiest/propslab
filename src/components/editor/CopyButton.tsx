import { useState, useCallback, useEffect } from 'react';
import { Tooltip } from '../ui/Tooltip';
import { copyToClipboard } from '../../utils/clipboard';

interface CopyButtonProps {
  getText: () => string;
}

export function CopyButton({ getText }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  // Reset from an effect so the timer is cleared on unmount; a bare setTimeout
  // in the click handler outlived the button (#322). Same shape as ClearButton.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // Settled here rather than left to the click handler: a rejected copy must not
  // flip the label to "Copied!", and as a floating promise it would also reach
  // the console as an unhandled rejection.
  const handleCopy = useCallback(() => {
    copyToClipboard(getText()).then(
      () => setCopied(true),
      () => {
        // The copy did not happen and there is no error surface here — leave the
        // button as it was rather than claiming success.
      },
    );
  }, [getText]);

  return (
    <Tooltip content={copied ? 'Copied!' : 'Copy to clipboard'} side="bottom">
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 px-2 py-1 text-xs rounded
        bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]
        hover:bg-[var(--color-accent)] hover:text-white transition-colors"
      aria-label={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? (
        <>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Copy
        </>
      )}
    </button>
    </Tooltip>
  );
}
