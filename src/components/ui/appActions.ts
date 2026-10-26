// ---------------------------------------------------------------------------
// appActions.ts
// The app-level actions that the command palette and the context menus both
// offer (#745), so each has one implementation.
//
// "Open", not "toggle": the target may already be open behind the palette or
// the menu, and choosing the action must not close it.
// ---------------------------------------------------------------------------

import { useAppStore } from '../../store/useAppStore';

export function openScaffold(): void {
  const s = useAppStore.getState();
  if (!s.scaffoldOpen) s.toggleScaffold();
}

export function openHelp(): void {
  const s = useAppStore.getState();
  if (!s.helpOpen) s.toggleHelp();
}

export function openAbout(): void {
  const s = useAppStore.getState();
  if (!s.aboutOpen) s.toggleAbout();
}

export function openCommandPalette(): void {
  const s = useAppStore.getState();
  if (!s.commandPaletteOpen) s.toggleCommandPalette();
}
