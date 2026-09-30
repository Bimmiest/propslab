export function chunkKey(file: string): string;
export function budgetRows(
  files: { file: string; kb: number }[],
  budgets: Record<string, number>,
  defaultKb: number,
): { key: string; kb: number; budget: number; over: boolean }[];
export function staleBudgets(budgets: Record<string, number>, rows: { key: string }[]): string[];
export function initialLoadFiles(html: string): string[];
