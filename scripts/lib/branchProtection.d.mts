/** The CI checks main must require by name. */
export const REQUIRED_CHECKS: readonly string[];

export class ApiError extends Error {
  path: string;
  status: number;
  constructor(path: string, status: number);
}

export interface MainProtectionResult {
  /** ok: every requirement met; incomplete: something missing; skipped: something missing but classic protection was unreadable (403). */
  status: 'ok' | 'incomplete' | 'skipped';
  missing: string[];
  sources: string[];
  notes: string[];
}

export function evaluateMainProtection(readers: {
  getRules: () => Promise<object[]>;
  getClassic: () => Promise<object>;
  getRuleset?: (id: number) => Promise<object>;
}): Promise<MainProtectionResult>;
