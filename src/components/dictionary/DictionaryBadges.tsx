import type React from 'react';
import type { DirectiveInfo } from '../../engine/directiveRegistry';
import { tint } from '../../utils/tint';

type Tone = 'index' | 'search' | 'neutral' | 'danger';

const TONE_COLORS: Record<Tone, string> = {
  // Index-time warning-amber and search-time accent match the colour coding the
  // pipeline reference drawer already uses for the two phases.
  index: 'var(--color-warning)',
  search: 'var(--color-accent)',
  // Secondary, not muted: muted has no margin left for the tint beneath it.
  neutral: 'var(--color-text-secondary)',
  danger: 'var(--color-error)',
};

/**
 * Small tinted pill. Distinct from the shared Badge component, which offers
 * only the four diagnostic severities — nothing here is a diagnostic.
 */
export function Chip({
  tone = 'neutral',
  mono = false,
  children,
}: {
  tone?: Tone;
  mono?: boolean;
  children: React.ReactNode;
}) {
  const color = TONE_COLORS[tone];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight whitespace-nowrap ${mono ? 'font-mono' : ''}`}
      // tint(), not a concatenated `${color}20` alpha suffix: these tones are
      // `var(--color-…)` references, and appending hex digits to a var() call
      // produces a declaration the browser drops — which is why these pills
      // rendered as bare coloured text with no fill.
      style={{ backgroundColor: tint(color, 10), color }}
    >
      {children}
    </span>
  );
}

const PHASE_TONE: Record<DirectiveInfo['phase'], Tone> = {
  'index-time': 'index',
  'search-time': 'search',
  both: 'neutral',
};

const PHASE_LABEL: Record<DirectiveInfo['phase'], string> = {
  'index-time': 'Index-time',
  'search-time': 'Search-time',
  both: 'Index + search',
};

export function PhaseBadge({ phase }: { phase: DirectiveInfo['phase'] }) {
  return <Chip tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Chip>;
}

const FILE_LABEL: Record<DirectiveInfo['appliesTo'], string> = {
  'props.conf': 'props.conf',
  'transforms.conf': 'transforms.conf',
  both: 'props + transforms',
};

/** Compact forms for the browse list, where the column is narrow. */
const FILE_LABEL_SHORT: Record<DirectiveInfo['appliesTo'], string> = {
  'props.conf': 'props',
  'transforms.conf': 'transforms',
  both: 'both',
};

export function FileBadge({ appliesTo, short = false }: { appliesTo: DirectiveInfo['appliesTo']; short?: boolean }) {
  return <Chip mono>{(short ? FILE_LABEL_SHORT : FILE_LABEL)[appliesTo]}</Chip>;
}

/**
 * Whether the preview honours the directive. Only shown when it does
 * not: a badge on all 76 entries would be noise, and "simulated" is what a
 * reader of a simulator's reference already assumes.
 */
export function SupportBadge({ support }: { support: DirectiveInfo['support'] }) {
  if (support === 'simulated') return null;
  return support === 'ignored' ? <Chip tone="danger">not simulated</Chip> : <Chip>out of scope</Chip>;
}

/** The full badge row for a directive, in a fixed order so rows stay scannable. */
export function DirectiveBadges({ info }: { info: DirectiveInfo }) {
  return (
    <>
      <PhaseBadge phase={info.phase} />
      <FileBadge appliesTo={info.appliesTo} />
      {info.isClassBased && <Chip>class-based</Chip>}
      {info.deprecated && <Chip tone="danger">deprecated</Chip>}
      <SupportBadge support={info.support} />
    </>
  );
}
