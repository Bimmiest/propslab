export const CANARY_FILE: string;
export const MIN_KILLED: number;
export const MIN_SCORE: number;
export function tally(mutants: { status: string }[]): { killed: number; total: number };
export function verdict(
  report: { files?: Record<string, { mutants: { status: string }[] } | undefined> },
  file?: string,
): string | null;
