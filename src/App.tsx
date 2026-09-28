import { useTheme } from './hooks/useTheme';
import { AppShell } from './components/layout/AppShell';
import { RootErrorBoundary } from './components/ui/RootErrorBoundary';

function App() {
  useTheme();

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-[var(--color-accent)] focus:text-[var(--color-text-on-accent)] focus:rounded-md focus:text-sm focus:font-medium"
      >
        Skip to main content
      </a>
      <RootErrorBoundary>
        <AppShell />
      </RootErrorBoundary>
    </>
  );
}

export default App;
