import * as RCM from '@radix-ui/react-context-menu';
import type React from 'react';

/**
 * Token-styled wrappers over @radix-ui/react-context-menu (mirrors how Tooltip
 * wraps radix-tooltip). Radix handles positioning, keyboard nav, portal/collision,
 * and Esc/outside-click dismissal.
 *
 * Usage:
 *   <ContextMenu>
 *     <ContextMenuTrigger><div>right-click me</div></ContextMenuTrigger>
 *     <ContextMenuContent>
 *       <ContextMenuLabel>Field</ContextMenuLabel>
 *       <ContextMenuItem onSelect={…}>Copy value</ContextMenuItem>
 *       <ContextMenuSeparator />
 *       <ContextMenuItem onSelect={…}>Pin field</ContextMenuItem>
 *     </ContextMenuContent>
 *   </ContextMenu>
 */
// A wrapper component rather than `export const ContextMenu = RCM.Root`.
// react-refresh/only-export-components cannot tell that a re-exported binding is
// a component, so the bare alias reads to it as a non-component export and
// disables Fast Refresh for this whole file. Declaring it is also what the other
// five exports here already do.
export function ContextMenu(props: React.ComponentProps<typeof RCM.Root>) {
  return <RCM.Root {...props} />;
}

export function ContextMenuTrigger({ children, asChild = true }: { children: React.ReactNode; asChild?: boolean }) {
  return <RCM.Trigger asChild={asChild}>{children}</RCM.Trigger>;
}

export function ContextMenuContent({ children }: { children: React.ReactNode }) {
  return (
    <RCM.Portal>
      <RCM.Content
        className="z-50 min-w-[11rem] rounded-md py-1 shadow-lg animate-in fade-in-0 zoom-in-95"
        style={{
          backgroundColor: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
        }}
      >
        {children}
      </RCM.Content>
    </RCM.Portal>
  );
}

export function ContextMenuItem({
  children,
  onSelect,
  disabled,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <RCM.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex items-center gap-2 mx-1 px-2 py-1.5 rounded text-xs cursor-pointer outline-none select-none
        text-[var(--color-text-primary)] data-[highlighted]:bg-[var(--color-accent)] data-[highlighted]:text-[var(--color-text-on-accent)]
        data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed"
    >
      {children}
    </RCM.Item>
  );
}

export function ContextMenuSeparator() {
  return <RCM.Separator className="my-1 h-px" style={{ backgroundColor: 'var(--color-border)' }} />;
}

export function ContextMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <RCM.Label className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
      {children}
    </RCM.Label>
  );
}
