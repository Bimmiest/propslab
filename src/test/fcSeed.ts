/**
 * Helper to manage fast-check seeds for reproducible property testing.
 * Returns process.env.FC_SEED if set, otherwise the provided default.
 * Logs the seed once when FC_SEED is set.
 *
 * An FC_SEED that is not an integer (an empty string, `1.5`, `0x10`) throws
 * rather than falling back: it is set only to replay a run or to draw a fresh
 * one, and either way running the default instead would claim a seed the run
 * never used.
 */

let seedLogged = false;

/** The app's tsconfig has no Node types, so `process` is reached through globalThis. */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export function fcSeed(defaultSeed: number): number {
  const envSeed = env?.['FC_SEED'];
  if (envSeed === undefined) return defaultSeed;
  const parsed = Number(envSeed);
  if (!/^-?\d+$/.test(envSeed) || !Number.isSafeInteger(parsed)) {
    throw new Error(`FC_SEED must be an integer, got ${JSON.stringify(envSeed)}`);
  }
  if (!seedLogged) {
    console.warn(`[fcSeed] Using fast-check seed from FC_SEED: ${parsed}`);
    seedLogged = true;
  }
  return parsed;
}
