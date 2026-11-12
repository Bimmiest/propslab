import { describe, it, expect } from 'vitest';
import { CIM_MATCH_THRESHOLD_PERCENT, matchesModel, rankModels } from '../cimMatching';
import { validateCimCompliance, type CimValidationResult } from '../../engine/cim/cimModels';

const run = (fields: string[]) => validateCimCompliance(new Set(fields), { includeAll: true });
const find = (results: CimValidationResult[], name: string) => {
  const r = results.find((x) => x.model.name === name);
  if (!r) throw new Error(`no model ${name}`);
  return r;
};

// Network_Traffic requires 13 fields and recommends 38; Authentication requires 6.
const TRAFFIC_REQUIRED = ['action', 'bytes', 'bytes_in', 'bytes_out', 'dest', 'dest_port', 'dvc', 'rule', 'src'];

describe('matchesModel (#896)', () => {
  it('states a threshold of 50% of the required fields', () => {
    expect(CIM_MATCH_THRESHOLD_PERCENT).toBe(50);
  });

  it('does not match a model that shares only a field or two', () => {
    const results = run(['src', 'dest']);
    expect(find(results, 'Network_Traffic').requiredPresent).toEqual(['dest', 'src']);
    expect(matchesModel(find(results, 'Network_Traffic'))).toBe(false);
    expect(results.filter(matchesModel).length).toBeLessThan(results.length);
  });

  it('matches at exactly the threshold and not below it', () => {
    // 3 of Authentication's 6 required fields is 50%; 2 of 6 is 33%.
    expect(matchesModel(find(run(['action', 'app', 'dest']), 'Authentication'))).toBe(true);
    expect(matchesModel(find(run(['action', 'app']), 'Authentication'))).toBe(false);
  });

  it('does not match a model that has none of the fields, even one with no required fields', () => {
    const results = run([]);
    expect(results.filter(matchesModel)).toEqual([]);
    expect(find(results, 'Databases').requiredPercent).toBe(100);
  });

  it('holds a model with no required field to half of all its fields', () => {
    const databases = find(run([]), 'Databases');
    const all = databases.model.recommendedFields;
    const half = Math.ceil(all.length / 2);
    expect(matchesModel(find(run(all.slice(0, half)), 'Databases'))).toBe(true);
    expect(matchesModel(find(run(all.slice(0, half - 1)), 'Databases'))).toBe(false);
  });
});

describe('rankModels (#896)', () => {
  it('puts the model with the best required coverage first, ahead of a larger total', () => {
    // Every required field of Network_Traffic, and 5 of its 38 others.
    const fields = [...TRAFFIC_REQUIRED, 'user', 'transport', 'src_port', 'vendor_product', 'app', 'src_ip', 'dest_ip'];
    const results = run(fields);
    const ranked = rankModels(results);
    expect(find(ranked, 'Network_Traffic').requiredPercent).toBe(100);
    // Every model that the data fits in full comes before one that it fits in part.
    const firstPartial = ranked.findIndex((r) => r.requiredPercent < 100 && r.model.requiredFields.length > 0);
    expect(ranked.indexOf(find(ranked, 'Network_Traffic'))).toBeLessThan(firstPartial);
    // Required coverage never rises down the list.
    const scores = ranked.map((r) => (r.model.requiredFields.length > 0 ? r.requiredPercent : r.totalPercent));
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it('ranks 92% required and 29% total above 44% required and 56% total (the issue)', () => {
    const [a, b] = run(['action']).filter((r) => r.model.requiredFields.length > 0);
    if (!a || !b) throw new Error('need two models');
    const traffic = { ...a, requiredPercent: 92, totalPercent: 29 };
    const intrusion = { ...b, requiredPercent: 44, totalPercent: 56 };
    expect(rankModels([intrusion, traffic])).toEqual([traffic, intrusion]);
  });

  it('breaks a tie in required coverage by total coverage', () => {
    const [a, b] = run(['action']).filter((r) => r.requiredPercent === 0 && r.model.requiredFields.length > 0);
    if (!a || !b) throw new Error('need two models');
    const low = { ...a, totalPercent: 10 };
    const high = { ...b, totalPercent: 40 };
    expect(rankModels([low, high])).toEqual([high, low]);
    expect(rankModels([high, low])).toEqual([high, low]);
  });

  it('ranks a model with no required field by its total, not as 100%', () => {
    const ranked = rankModels(run([]));
    const names = ranked.map((r) => r.model.name);
    // 0% everywhere: nothing may sit first for having an empty required list.
    expect(ranked.every((r) => r.totalPercent === 0 || r.model.requiredFields.length === 0)).toBe(true);
    expect(names.indexOf('Databases')).toBeGreaterThan(-1);
    const withSessions = rankModels(run(find(run([]), 'Databases').model.recommendedFields));
    expect(withSessions[0]?.model.name).toBe('Databases');
  });

  it('does not change its input', () => {
    const results = run(TRAFFIC_REQUIRED);
    const copy = [...results];
    rankModels(results);
    expect(results).toEqual(copy);
  });
});
