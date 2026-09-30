// A RunContext for calling one stage directly, as a test does. Production code
// has no default clock or diagnostics list; a test says which clock it runs
// under (#507), so a result that depends on the date can be traced to the line
// that chose it rather than to a default in this file.
import { createRunContext, type RunContext } from '../runContext';
import type { ValidationDiagnostic } from '../types';

/**
 * The clock for a test that does not care what time it is: 2026-09-01T00:00:00Z.
 * Recent enough that the dated inputs the suite uses stay inside MAX_DAYS_AGO
 * and are not in the future. A test that does care passes its own instant.
 */
export const FIXED_NOW = 1788220800000;

/**
 * @param now         The run's clock, in epoch milliseconds or as a Date. Required.
 * @param diagnostics The list the run's diagnostics are appended to; a fresh one nobody reads by default.
 */
export function runCtx(
  now: number | Date,
  diagnostics?: ValidationDiagnostic[],
  init: { captureOffsets?: boolean } = {},
): RunContext {
  const { captureOffsets } = init;
  return createRunContext({
    now: typeof now === 'number' ? now : now.getTime(),
    ...(captureOffsets !== undefined ? { captureOffsets } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  });
}
