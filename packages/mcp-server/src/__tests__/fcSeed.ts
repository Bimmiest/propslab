/**
 * Helper to manage fast-check seeds for reproducible property testing.
 * Returns process.env.FC_SEED if set and valid, otherwise the provided default.
 * Logs the seed once when FC_SEED is set.
 */

let seedLogged = false;

export function fcSeed(defaultSeed: number): number {
  const envSeed = process.env.FC_SEED;
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
