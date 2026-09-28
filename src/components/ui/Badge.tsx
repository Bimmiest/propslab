import type React from 'react';

interface BadgeProps {
  variant: 'error' | 'warning' | 'info' | 'success';
  children: React.ReactNode;
}

export function Badge({ variant, children }: BadgeProps) {
  const color = `var(--color-${variant})`;

  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium leading-tight"
      style={{
        // Tinted from the text's own token at the 10% every other status chip
        // uses, so the pair keeps 4.5:1 in both themes.
        backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
        color,
      }}
    >
      {children}
    </span>
  );
}
