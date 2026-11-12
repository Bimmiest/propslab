import type { CimValidationResult } from 'propslab-engine';

/**
 * A model matches the data when the data has at least this share of the
 * model's required fields (#896). Before, a model matched when it shared one
 * field, so every model matched.
 */
export const CIM_MATCH_THRESHOLD_PERCENT = 50;

/** How well the data fits the model. A model with no required field has no required score, so its total stands in. */
function fitScore(r: CimValidationResult): number {
  return r.model.requiredFields.length > 0 ? r.requiredPercent : r.totalPercent;
}

/** True when the data has some field of the model and enough of its required fields. */
export function matchesModel(r: CimValidationResult): boolean {
  const anyPresent = r.requiredPresent.length > 0 || r.recommendedPresent.length > 0;
  return anyPresent && fitScore(r) >= CIM_MATCH_THRESHOLD_PERCENT;
}

/** How many of the model's key fields the data has: the required ones, or all of them when it requires none. */
function fitCount(r: CimValidationResult): number {
  return r.model.requiredFields.length > 0
    ? r.requiredPresent.length
    : r.requiredPresent.length + r.recommendedPresent.length;
}

/**
 * The models in order of fit. Matching models come first. Within each group:
 * the number of required fields present, then the share of them, then the
 * share of all fields. The count comes before the share so that a model with
 * one required field (Performance has only `dest`) does not outrank a model
 * with most of 13 (Network Traffic), as a share alone would. A model with a
 * long optional list does not fall below a model that the data does not fit.
 * Returns a new array and keeps the input order for a tie.
 */
export function rankModels(results: readonly CimValidationResult[]): CimValidationResult[] {
  return [...results].sort(
    (a, b) =>
      Number(matchesModel(b)) - Number(matchesModel(a)) ||
      fitCount(b) - fitCount(a) ||
      fitScore(b) - fitScore(a) ||
      b.totalPercent - a.totalPercent,
  );
}
