import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';

/**
 * Put the theme class on <html>. main.tsx also calls this synchronously before
 * awaiting the regex engine: waiting for the first render's effect painted a
 * dark-default page light for as long as the wasm took to load.
 */
export function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function useTheme() {
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, toggleTheme };
}
