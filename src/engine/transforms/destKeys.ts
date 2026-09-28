/**
 * The DEST_KEY vocabulary, in one place, so config-time validation
 * (configLint), the match-time warning (transformsProcessor) and the router
 * describe a stanza the same way whether or not its REGEX happened to match.
 */

/** Keys the router models. Compare after normalising the `_MetaData:` alias. */
export const SIMULATED_DEST_KEYS: ReadonlySet<string> = new Set([
  'queue',
  '_raw',
  '_meta',
  '_time',
  'MetaData:Host',
  'MetaData:Index',
  'MetaData:Source',
  'MetaData:Sourcetype',
]);

/** Documented Splunk routing keys this tool recognises but does not model. */
export const VALID_UNSIMULATED_DEST_KEYS: ReadonlySet<string> = new Set([
  '_TCP_ROUTING',
  '_SYSLOG_ROUTING',
  '_INDEX_AND_FORWARD_ROUTING',
]);

/** Strip the `_MetaData:X` alias down to the `MetaData:X` the sets are keyed by. */
export function normaliseDestKey(destKey: string): string {
  return destKey.trim().replace(/^_(?=MetaData:)/i, '');
}

/** True for a key Splunk accepts, whether or not this tool models its effect. */
export function isKnownDestKey(destKey: string): boolean {
  const normalised = normaliseDestKey(destKey);
  return SIMULATED_DEST_KEYS.has(normalised) || VALID_UNSIMULATED_DEST_KEYS.has(normalised);
}
