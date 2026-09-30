import { CIM_MODELS, type CimModel } from './cimModelsData';

export interface CimValidationResult {
  model: CimModel;
  requiredPresent: string[];
  requiredMissing: string[];
  recommendedPresent: string[];
  recommendedMissing: string[];
  requiredPercent: number;
  totalPercent: number;
}

export function validateCimCompliance(
  extractedFields: Set<string>,
  options?: { includeAll?: boolean },
): CimValidationResult[] {
  const results = CIM_MODELS.map((model) => {
    const requiredPresent: string[] = [];
    const requiredMissing: string[] = [];
    for (const f of model.requiredFields) {
      if (extractedFields.has(f)) requiredPresent.push(f);
      else requiredMissing.push(f);
    }
    const recommendedPresent: string[] = [];
    const recommendedMissing: string[] = [];
    for (const f of model.recommendedFields) {
      if (extractedFields.has(f)) recommendedPresent.push(f);
      else recommendedMissing.push(f);
    }

    const totalFields = model.requiredFields.length + model.recommendedFields.length;
    const totalPresent = requiredPresent.length + recommendedPresent.length;

    const requiredPercent =
      model.requiredFields.length > 0 ? Math.round((requiredPresent.length / model.requiredFields.length) * 100) : 100;

    const totalPercent = totalFields > 0 ? Math.round((totalPresent / totalFields) * 100) : 100;

    return {
      model,
      requiredPresent,
      requiredMissing,
      recommendedPresent,
      recommendedMissing,
      requiredPercent,
      totalPercent,
    };
  });

  const filtered = options?.includeAll
    ? results
    : results.filter((r) => r.requiredPresent.length > 0 || r.recommendedPresent.length > 0);

  return filtered.sort((a, b) => b.totalPercent - a.totalPercent);
}
