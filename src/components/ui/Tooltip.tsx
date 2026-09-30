import * as RadixTooltip from '@radix-ui/react-tooltip';
import type React from 'react';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delayDuration?: number;
}

export function Tooltip({ content, children, side = 'top', delayDuration = 400 }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 px-2.5 py-1.5 text-xs rounded-md shadow-lg select-none"
          style={{
            backgroundColor: 'var(--color-bg-elevated)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}
        >
          {content}
          <RadixTooltip.Arrow
            style={{ fill: 'var(--color-border)' }}
            width={10}
            height={5}
          />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

