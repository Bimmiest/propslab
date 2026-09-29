// A RunContext for calling one stage directly, as a test does. Production code
// has no default clock or diagnostics list; a test that does not care about
// either gets a fixed clock (for reproducibility) and a list nobody reads.
import { createRunContext, type RunContext } from '../runContext';
import type { ValidationDiagnostic } from '../types';

// Fixed default clock for reproducible tests: 2026-09-01T00:00:00.000Z. Recent
// enough that the dated inputs the suite uses stay inside MAX_DAYS_AGO and
// are not in the future; tests that care about the clock pass `now`.
const DEFAULT_NOW = 1788220800000;

export function runCtx(
  diagnostics?: ValidationDiagnostic[],
  init: { now?: number | Date; captureOffsets?: boolean } = {},
): RunContext {
  const { now = DEFAULT_NOW, captureOffsets } = init;
  return createRunContext({
    now: typeof now === 'number' ? now : now.getTime(),
    ...(captureOffsets !== undefined ? { captureOffsets } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  });
}
