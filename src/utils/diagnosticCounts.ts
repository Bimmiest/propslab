import type { DiagnosticLevel, ValidationDiagnostic } from '../engine/types';

/** How many of the diagnostics there are at each level. */
export function countByLevel(diagnostics: readonly ValidationDiagnostic[]): Record<DiagnosticLevel, number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.level]++;
  return counts;
}
