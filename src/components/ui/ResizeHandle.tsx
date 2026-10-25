import { Separator } from 'react-resizable-panels';

/** The drag handle between two panels of a react-resizable-panels group. */
export function ResizeHandle({ direction = 'vertical' }: { direction?: 'horizontal' | 'vertical' }) {
  return (
    <Separator
      className={`
        group relative flex items-center justify-center
        ${direction === 'vertical' ? 'h-1.5 cursor-row-resize' : 'w-1.5 cursor-col-resize'}
        bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors
      `}
    >
      <div
        className={`
          rounded-full bg-[var(--color-text-muted)] group-hover:bg-white transition-colors
          ${direction === 'vertical' ? 'h-0.5 w-8' : 'w-0.5 h-8'}
        `}
      />
    </Separator>
  );
}
