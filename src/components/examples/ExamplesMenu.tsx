// ---------------------------------------------------------------------------
// ExamplesMenu.tsx
// The example library: a button that opens the bundled examples, grouped by
// the kind of data source (#666). The header has one, so an example can be
// loaded at any time, and the empty output shows one as its invitation.
// ---------------------------------------------------------------------------

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { SAMPLE_CONFIGS, type SampleConfig } from '../../engine/sampleData';
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss';
import { Icon, type IconName } from '../ui/Icon';
import { useReplaceInputs } from '../ui/useReplaceInputs';

const ICONS: Record<string, IconName> = {
  'Apache Access Log': 'terminal',
  'Palo Alto Firewall': 'shield',
  'Linux SSH Auth': 'eye',
  'Windows Security (XML)': 'clipboard',
  'AWS CloudTrail (JSON)': 'tag',
  'Cisco ASA': 'shield',
  'Java App (Multi-line)': 'book',
  'FortiGate Traffic': 'sliders',
};

/** The examples by category, in the order each category first appears. */
const GROUPS: [string, SampleConfig[]][] = [
  ...SAMPLE_CONFIGS.reduce((groups, sample) => {
    groups.set(sample.category, [...(groups.get(sample.category) ?? []), sample]);
    return groups;
  }, new Map<string, SampleConfig[]>()),
];

/**
 * The height the list can take below its button: down to the bottom of the
 * window, or of the nearest container that scrolls or clips it, less the gap
 * above the list and a margin below it.
 */
function roomBelow(trigger: HTMLElement): number {
  let bottom = window.innerHeight;
  for (let el = trigger.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowY !== 'visible') {
      bottom = Math.min(bottom, el.getBoundingClientRect().bottom);
      break;
    }
  }
  return bottom - trigger.getBoundingClientRect().bottom - 12;
}

/**
 * A disclosure, not a menu: the popup is a list of buttons that Tab walks,
 * like MultiSelect's, and `aria-haspopup="menu"` would promise an arrow-key
 * model it does not have.
 */
export function ExamplesMenu({ prominent = false }: { prominent?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const close = useCallback(() => setOpen(false), []);
  const dismiss = usePopoverDismiss(ref, triggerRef, open, close);
  const { replace, confirm } = useReplaceInputs();
  const [room, setRoom] = useState<number>();

  // Before paint, so the list never shows at a height that runs off the page.
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      if (triggerRef.current) setRoom(roomBelow(triggerRef.current));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);

  const load = (sample: SampleConfig) => {
    close();
    replace(sample, 'Load example', `Loading “${sample.name}”`);
  };

  return (
    // The wrapper listens for keys and focus bubbling up from its own controls;
    // it is not itself interactive.
    <div ref={ref} className="relative" {...dismiss}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        className={
          prominent
            ? 'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-on-accent)] hover:opacity-90 press'
            : 'flex items-center gap-1.5 px-2 h-7 rounded-md text-xs border border-[var(--color-border-control)] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] press'
        }
        // Only the header's label hides on narrow screens; the name stays.
        aria-label={prominent ? undefined : 'Examples'}
      >
        <Icon name="book" className={prominent ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
        <span className={prominent ? undefined : 'hidden sm:inline'}>{prominent ? 'Load an example' : 'Examples'}</span>
        <Icon name="chevron-down" className="w-3 h-3" />
      </button>
      {open && (
        <div
          id={popupId}
          role="group"
          aria-label="Examples"
          className={[
            'motion-pop-in absolute top-full mt-1 z-50 w-[22rem] max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto py-1 rounded-lg border shadow-lg text-left',
            prominent ? 'left-1/2 -translate-x-1/2 origin-top' : 'right-0 origin-top-right',
          ].join(' ')}
          style={{
            backgroundColor: 'var(--color-bg-elevated)',
            borderColor: 'var(--color-border)',
            // A floor of about two examples, so a cramped window still shows a list to scroll.
            ...(room !== undefined && { maxHeight: `min(70vh, ${Math.max(room, 160)}px)` }),
          }}
        >
          {GROUPS.map(([category, samples]) => (
            <section key={category} aria-label={category}>
              <h3 className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                {category}
              </h3>
              {samples.map((sample) => (
                <button
                  key={sample.name}
                  type="button"
                  onClick={() => load(sample)}
                  className="w-full flex items-start gap-3 px-3 py-2 text-left cursor-pointer outline-none hover:bg-[var(--color-bg-tertiary)] focus-visible:bg-[var(--color-bg-tertiary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
                >
                  <Icon
                    name={ICONS[sample.name] ?? 'document'}
                    className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-accent)]"
                  />
                  <span>
                    <span className="block text-xs font-semibold text-[var(--color-text-primary)]">{sample.name}</span>
                    <span className="block text-xs leading-relaxed text-[var(--color-text-muted)]">
                      {sample.description}
                    </span>
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
      {confirm}
    </div>
  );
}
