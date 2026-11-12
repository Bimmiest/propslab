import type { CimValidationResult } from '../engine/cim/cimModels';

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

/**
 * The models in order of fit: required coverage first, total coverage second.
 * A model with a long optional list must not rank below a model that the data
 * does not fit. Returns a new array and keeps the input order for a tie.
 */
export function rankModels(results: readonly CimValidationResult[]): CimValidationResult[] {
  return [...results].sort((a, b) => fitScore(b) - fitScore(a) || b.totalPercent - a.totalPercent);
}
