import { useMemo } from 'react';
import { useRegexMatch } from '../../../../hooks/useRegexMatch';
import { validateRegex } from '../../../../utils/splunkRegex';

export type Capture =
  | { state: 'empty' }
  | { state: 'pending' }
  | { state: 'invalid'; reason: string | null }
  | { state: 'timeout' }
  | { state: 'nomatch' }
  | { state: 'nogroup'; full: string }
  | { state: 'ok'; full: string; groups: [string, string][] };

/**
 * What `trimmed` (a pattern) captures in `raw`.
 *
 * The live capture runs the user's pattern in a terminatable Web Worker rather
 * than on this thread, like every other run of a user's pattern. Shared by the
 * from-selection dialogs, which gate Apply on a settled outcome (see
 * `isSettledCapture`) so a pattern that does not compile, or is still inside
 * the watchdog window, cannot reach props.conf.
 */
export function useLiveCapture(raw: string, trimmed: string): Capture {
  const inputs = useMemo(() => [raw], [raw]);
  // Compile-only check on this thread, as the Regex tab does: compiling cannot
  // backtrack, and a syntax error is caught before anything is sent to the worker.
  const validationError = useMemo(() => (trimmed ? validateRegex(trimmed) : null), [trimmed]);
  const requestedPattern = validationError ? '' : trimmed;
  const { status, results, pattern: matchedPattern, inputs: matchedInputs } = useRegexMatch(requestedPattern, inputs);

  return useMemo<Capture>(() => {
    if (!trimmed) return { state: 'empty' };
    if (validationError) return { state: 'invalid', reason: validationError };
    // Matching runs on a debounced copy of the pattern, so for 250 ms after each
    // keystroke the hook still reports the previous pattern's outcome, which
    // would put another pattern's captures under "Captures in this event".
    // Only an outcome for exactly this pattern and this
    // event counts; anything else is still pending.
    if (matchedPattern !== requestedPattern) return { state: 'pending' };
    if (status === 'invalid') return { state: 'invalid', reason: null };
    if (status === 'timeout') return { state: 'timeout' };
    if (status !== 'ok' || matchedInputs !== inputs) return { state: 'pending' };
    const info = results[0];
    if (!info) return { state: 'nomatch' };
    const groups = Object.entries(info.groups);
    if (groups.length === 0) return { state: 'nogroup', full: info.match };
    return { state: 'ok', full: info.match, groups };
  }, [trimmed, validationError, requestedPattern, inputs, status, results, matchedPattern, matchedInputs]);
}

/**
 * A settled run of exactly this pattern that compiled and finished inside the
 * watchdog. A timeout does not count: the pipeline would hit the same wall on
 * every event the stanza applies to.
 */
export function isSettledCapture(capture: Capture): boolean {
  return capture.state === 'ok' || capture.state === 'nomatch' || capture.state === 'nogroup';
}
