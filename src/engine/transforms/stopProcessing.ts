import type { ConfDirective, SplunkEvent, ValidationDiagnostic } from '../types';
import { evaluateExpression, regexFailureMessage } from '../processors/evalProcessor';
import { atDirective } from '../parser/provenance';
import { effectiveDirective } from '../utils/directiveValues';

/**
 * How transforms.conf.spec reads a STOP_PROCESSING_IF result: "numeric 0 and
 * null are false, everything else is true".
 *
 * Deliberately not the eval engine's own `toBool`, which also treats "" and
 * "false" as false — the spec's rule is narrower, and a string like "false" is
 * "everything else". A string that reads as the number 0 counts as numeric 0,
 * because an event field holding `0` arrives here as the string "0" and eval is
 * typeless about that. An empty multivalue is how the eval engine spells null.
 */
export function stopConditionHolds(value: string | number | boolean | null | string[]): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  const trimmed = value.trim();
  return !(trimmed !== '' && Number(trimmed) === 0);
}

/**
 * Evaluate a stanza's STOP_PROCESSING_IF against the event as it stands after
 * the stanza's INGEST_EVAL (the spec orders them that way).
 *
 * Returns `undefined` when the stanza has no STOP_PROCESSING_IF. An expression
 * that fails to evaluate does not stop processing: Splunk cannot act on a
 * condition it could not compute, and stopping would silently skip rules on the
 * strength of an error. The failure is reported instead.
 */
export function evaluateStopCondition(
  event: SplunkEvent,
  stanzaDirectives: ConfDirective[],
  diagnostics: ValidationDiagnostic[] | undefined,
  now: number,
): { stop: boolean; expression: string } | undefined {
  // Last definition wins, as for every other transforms setting.
  const dir = effectiveDirective(stanzaDirectives, 'STOP_PROCESSING_IF');
  if (!dir) return undefined;
  const expression = dir.value.trim();
  if (expression === '') return undefined;

  // Deduplicated against the list itself: this runs once per event, and a
  // config problem reported 500 times buries everything else.
  const report = (level: ValidationDiagnostic['level'], message: string) => {
    if (!diagnostics || diagnostics.some((d) => d.message === message)) return;
    diagnostics.push({ level, message, file: 'transforms.conf', ...atDirective(dir), directiveKey: dir.key });
  };

  try {
    const value = evaluateExpression(
      expression,
      event,
      (fn) => report('warning', `${fn}() is not fully simulated — results may differ from real Splunk`),
      now,
      (fn, pattern) => report('warning', `STOP_PROCESSING_IF: ${regexFailureMessage(fn, pattern)}`),
    );
    return { stop: stopConditionHolds(value), expression };
  } catch (err) {
    report(
      'error',
      `STOP_PROCESSING_IF could not be evaluated, so processing continues: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { stop: false, expression };
  }
}
