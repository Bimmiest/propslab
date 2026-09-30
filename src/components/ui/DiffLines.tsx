import type { computeDiff } from '../../utils/diffEngine';

type DiffKind = 'added' | 'removed' | 'ctx';

const SIGN: Record<DiffKind, string> = { added: '+', removed: '-', ctx: ' ' };
const ROW_BG: Record<DiffKind, string> = { added: ' bg-[var(--color-success)]/10', removed: ' bg-[var(--color-error)]/10', ctx: '' };
const SIGN_COLOR: Record<DiffKind, string> = {
  added: 'text-[var(--color-success)]',
  removed: 'text-[var(--color-error)]',
  ctx: 'text-[var(--color-text-muted)]',
};
const TEXT_COLOR: Record<DiffKind, string> = {
  added: 'text-[var(--color-success)]',
  removed: 'text-[var(--color-error)]',
  ctx: 'text-[var(--color-text-primary)]',
};

/** A line diff as rows of sign gutter and text, one row per line of each segment. */
export function DiffLines({ diff }: { diff: ReturnType<typeof computeDiff> }) {
  return diff.map((segment, si) => {
    const kind: DiffKind = segment.added ? 'added' : segment.removed ? 'removed' : 'ctx';
    const lines = segment.value.replace(/\n$/, '').split('\n');
    return lines.map((line, li) => (
      <div key={`${si}-${li}`} className={`flex${ROW_BG[kind]}`}>
        <span className={`flex-shrink-0 w-6 text-center ${SIGN_COLOR[kind]} select-none`}>{SIGN[kind]}</span>
        <pre className={`flex-1 px-2 py-0.5 whitespace-pre-wrap break-all ${TEXT_COLOR[kind]}`}>{line}</pre>
      </div>
    ));
  });
}
