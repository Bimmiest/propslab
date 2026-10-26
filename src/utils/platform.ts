// ---------------------------------------------------------------------------
// platform.ts
// The modifier key a shortcut names: the header's palette button and the
// context menus' shortcut hints (#745) show the same one.
// ---------------------------------------------------------------------------

/** Detect whether the platform is Apple (Mac, iOS, iPad, etc.). */
export function isApplePlatform(): boolean {
  try {
    // Modern API, available in recent browsers
    const platform = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform;
    if (platform?.toLowerCase().includes('mac')) {
      return true;
    }
  } catch {
    // Fallback if userAgentData is not available
  }
  // Fallback: check navigator.platform for older browsers
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the fallback for older browsers
  return /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform);
}

/** Get the keyboard modifier name for the current platform. */
export function getModifierName(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}
