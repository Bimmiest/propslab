import { useState } from 'react';
import { Icon } from '../ui/Icon';

const STORAGE_KEY = 'propslab:seen-intro';
// The key this used before the app was renamed from Splunk Toolkit. Read, never
// written: without it every existing user gets the intro banner a second time.
const LEGACY_STORAGE_KEY = 'splunk-toolkit:seen-intro';

function hasSeenIntro(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true' || localStorage.getItem(LEGACY_STORAGE_KEY) === 'true';
  } catch {
    return true; // If storage is unavailable, don't show the banner
  }
}

function markIntroSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'true');
  } catch {
    // Silently ignore — storage unavailable
  }
}

const STEPS = [
  {
    number: '1',
    label: 'Paste raw logs',
    detail: 'Drop log lines into the Raw Log panel on the left',
  },
  {
    number: '2',
    label: 'Write your config',
    detail: 'Add stanzas to props.conf and transforms.conf',
  },
  {
    number: '3',
    label: 'Inspect the pipeline',
    detail: 'Check the Output panel to see extractions and transforms',
  },
];

export function FirstRunBanner() {
  const [visible, setVisible] = useState(() => !hasSeenIntro());

  if (!visible) return null;

  const dismiss = () => {
    markIntroSeen();
    setVisible(false);
    // The focused button unmounts with the banner, which would drop focus to
    // <body>; the skip link's target is the next sensible place.
    document.getElementById('main-content')?.focus();
  };

  return (
    <section
      aria-label="Getting started"
      className="shrink-0 flex items-start sm:items-center gap-2 sm:gap-4 px-4 py-2.5 border-b"
      style={{
        backgroundColor: 'var(--color-bg-elevated)',
        borderColor: 'var(--color-border-subtle)',
      }}
    >
      {/* Steps */}
      <div className="flex items-center gap-1 flex-1 min-w-0 flex-wrap">
        {STEPS.map((step, idx) => (
          <div key={step.number} className="flex items-center gap-1">
            <div
              className="flex items-center gap-2 px-2.5 py-1 rounded-lg"
              style={{ backgroundColor: 'var(--color-bg-secondary)' }}
            >
              <span
                className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-text-on-accent)' }}
              >
                {step.number}
              </span>
              <div className="hidden sm:block">
                <span className="text-xs font-semibold text-[var(--color-text-primary)]">{step.label}</span>
                <span className="text-xs text-[var(--color-text-muted)] ml-1.5 hidden md:inline">{step.detail}</span>
              </div>
              <span className="text-xs font-semibold text-[var(--color-text-primary)] sm:hidden">{step.label}</span>
            </div>
            {idx < STEPS.length - 1 && (
              <Icon name="arrow-right" className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0 mx-0.5" />
            )}
          </div>
        ))}
      </div>

      {/* Dismiss */}
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border-none cursor-pointer transition-colors text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
        aria-label="Dismiss welcome banner"
      >
        <Icon name="x" className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Got it</span>
      </button>
    </section>
  );
}
