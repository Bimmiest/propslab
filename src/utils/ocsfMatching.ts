import { OCSF_BASE_EVENT, type OcsfClass, type OcsfCoverageResult } from 'propslab-engine';

/**
 * A class matches the data when the data has at least this share of the
 * attributes that make the class different from others, as a CIM model does
 * (#896).
 */
export const OCSF_MATCH_THRESHOLD_PERCENT = 50;

/** A coverage result, with how well the data fits the class. */
export interface OcsfFit {
  result: OcsfCoverageResult;
  /** The events say that they are of this class: a `class_uid` field has its uid. */
  declared: boolean;
  /** The attributes that the fit counts: the required ones of the class itself, or its recommended ones when it has none. */
  key: string[];
  keyPresent: string[];
  /** The share of `key` that the data has, rounded. */
  keyPercent: number;
  matches: boolean;
}

/**
 * The attributes of a class at a requirement that base_event does not give
 * them. Each class has the attributes of base_event, so they cannot tell one
 * class from another. A base attribute that a class makes required is its own.
 */
function own(ocsfClass: OcsfClass, requirement: 'required' | 'recommended'): string[] {
  const base = new Set(OCSF_BASE_EVENT[requirement]);
  return ocsfClass[requirement].filter((name) => !base.has(name));
}

/**
 * The class_uid values that the events give, as numbers. A value that is not
 * a whole number is not a class_uid. A run with no `class_uid` field gives
 * none, and the events are not read.
 */
export function declaredClassUids(
  events: readonly { fields: Record<string, string | string[]> }[],
  fieldNames: readonly string[],
): Set<number> {
  const uids = new Set<number>();
  if (!fieldNames.includes('class_uid')) return uids;
  for (const { fields } of events) {
    for (const value of [fields['class_uid'] ?? []].flat()) {
      const text = value.trim();
      if (/^\d+$/.test(text)) uids.add(Number(text));
    }
  }
  return uids;
}

export function fitOf(result: OcsfCoverageResult, declared: ReadonlySet<number>): OcsfFit {
  const required = own(result.ocsfClass, 'required');
  const key = required.length > 0 ? required : own(result.ocsfClass, 'recommended');
  const present = new Set([...result.requiredPresent, ...result.recommendedPresent]);
  const keyPresent = key.filter((name) => present.has(name));
  const keyPercent = key.length > 0 ? Math.round((keyPresent.length / key.length) * 100) : 0;
  const isDeclared = declared.has(result.ocsfClass.uid);
  return {
    result,
    declared: isDeclared,
    key,
    keyPresent,
    keyPercent,
    matches: isDeclared || (keyPresent.length > 0 && keyPercent >= OCSF_MATCH_THRESHOLD_PERCENT),
  };
}

/**
 * The classes in order of fit. A class that the events declare comes first,
 * then the matching classes. Within each group: the number of key attributes
 * present, then their share, then the share of all the required and
 * recommended attributes. The count comes before the share for the reason
 * that `rankModels` gives for CIM. Returns a new array and keeps the input
 * order (class_uid) for a tie.
 */
export function rankClasses(results: readonly OcsfCoverageResult[], declared: ReadonlySet<number>): OcsfFit[] {
  return results
    .map((result) => fitOf(result, declared))
    .sort(
      (a, b) =>
        Number(b.declared) - Number(a.declared) ||
        Number(b.matches) - Number(a.matches) ||
        b.keyPresent.length - a.keyPresent.length ||
        b.keyPercent - a.keyPercent ||
        b.result.totalPercent - a.result.totalPercent,
    );
}
