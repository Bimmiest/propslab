/**
 * Helper to manage fast-check seeds for reproducible property testing.
 * Returns process.env.FC_SEED if set and valid, otherwise the provided default.
 * Logs the seed once when FC_SEED is set.
 */

let seedLogged = false;

/** The app's tsconfig has no Node types, so `process` is reached through globalThis. */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export function fcSeed(defaultSeed: number): number {
  const envSeed = env?.FC_SEED;
  if (envSeed !== undefined) {
    const parsed = Number(envSeed);
    if (!isNaN(parsed)) {
      if (!seedLogged) {
        console.warn(`[fcSeed] Using fast-check seed from FC_SEED: ${parsed}`);
        seedLogged = true;
      }
      return parsed;
    }
  }
  return defaultSeed;
}
