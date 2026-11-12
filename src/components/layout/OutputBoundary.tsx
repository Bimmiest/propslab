import type { ReactNode } from 'react';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { useAppStore } from '../../store/useAppStore';

/**
 * The Output panel's boundary, reset by each new result so that fixing the
 * input recovers a panel a render error took down (#563). A leaf of its own,
 * so a run re-renders it alone: its children are the caller's element. The
 * desktop and the phone layout share it (#883).
 */
export function OutputBoundary({ children }: { children: ReactNode }) {
  const result = useAppStore((s) => s.processingResult);
  return (
    <ErrorBoundary panelName="Output" resetKeys={[result]}>
      {children}
    </ErrorBoundary>
  );
}
