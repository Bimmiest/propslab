// A RunContext for calling one stage directly, as a test does. Production code
// has no default clock or diagnostics list; a test that does not care about
// either gets the real clock and a list nobody reads.
import { createRunContext, type RunContext } from '../runContext';
import type { ValidationDiagnostic } from '../types';

export function runCtx(
  diagnostics?: ValidationDiagnostic[],
  init: { now?: number | Date; captureOffsets?: boolean } = {},
): RunContext {
  const { now = Date.now(), captureOffsets } = init;
  return createRunContext({
    now: typeof now === 'number' ? now : now.getTime(),
    ...(captureOffsets !== undefined ? { captureOffsets } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  });
}
