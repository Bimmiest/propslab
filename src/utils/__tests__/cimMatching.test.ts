import { describe, it, expect } from 'vitest';
import { CIM_MATCH_THRESHOLD_PERCENT, matchesModel, rankModels } from '../cimMatching';
import { validateCimCompliance, type CimValidationResult, runPipeline, SAMPLE_CONFIGS } from '../../engine';
import { AT_FIXED_NOW } from '../../test/runCtx';

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
  it('puts the models that match before the others, whatever their totals', () => {
    const ranked = rankModels(run(['action', 'app', 'dest']));
    const flags = ranked.map(matchesModel);
    expect(flags).toEqual([...flags].sort((x, y) => Number(y) - Number(x)));
    expect(flags[0]).toBe(true);
    expect(flags.at(-1)).toBe(false);
  });

  it('ranks by the number of required fields present before their share (single required field)', () => {
    // Performance requires only `dest`: 100% with one field. Network_Traffic has 9 of 13: 69%.
    const results = run([...TRAFFIC_REQUIRED, 'transport', 'user']);
    const performance = find(results, 'Performance');
    const traffic = find(results, 'Network_Traffic');
    expect(performance.requiredPercent).toBe(100);
    expect(traffic.requiredPercent).toBeLessThan(performance.requiredPercent);
    expect(matchesModel(performance) && matchesModel(traffic)).toBe(true);
    const names = rankModels(results).map((r) => r.model.name);
    expect(names.indexOf('Network_Traffic')).toBeLessThan(names.indexOf('Performance'));
  });

  it('breaks a tie in the count by the share, then by the total', () => {
    const [a, b, c] = run(['action']).filter((r) => r.model.requiredFields.length > 0);
    if (!a || !b || !c) throw new Error('need three models');
    const base = { requiredPresent: ['x'], recommendedPresent: [] as string[] };
    const lowShare = { ...a, ...base, requiredPercent: 60, totalPercent: 90 };
    const highShare = { ...b, ...base, requiredPercent: 80, totalPercent: 10 };
    expect(rankModels([lowShare, highShare])).toEqual([highShare, lowShare]);
    const lowTotal = { ...c, ...base, requiredPercent: 80, totalPercent: 5 };
    expect(rankModels([lowTotal, highShare])).toEqual([highShare, lowTotal]);
  });

  it('ranks a model with no required field by the fields it has', () => {
    const databases = find(run([]), 'Databases').model.recommendedFields;
    const results = run([...databases, 'action']);
    expect(matchesModel(find(results, 'Databases'))).toBe(true);
    expect(rankModels(results)[0]?.model.name).toBe('Databases');
  });

  it('does not change its input', () => {
    const results = run(TRAFFIC_REQUIRED);
    const copy = [...results];
    rankModels(results);
    expect(results).toEqual(copy);
  });
});

describe('the Palo Alto Firewall example (#896)', () => {
  it('lists Network Traffic first, the model that the example is written for', () => {
    const pan = SAMPLE_CONFIGS.find((s) => s.name === 'Palo Alto Firewall');
    if (!pan) throw new Error('no Palo Alto example');
    const { result } = runPipeline(pan.rawData, pan.metadata, pan.propsConf, pan.transformsConf, AT_FIXED_NOW);
    const names = new Set(result.events.flatMap((e) => Object.keys(e.fields)));
    const ranked = rankModels(validateCimCompliance(names, { includeAll: true }));
    expect(ranked[0]?.model.name).toBe('Network_Traffic');
    expect(matchesModel(ranked[0] as CimValidationResult)).toBe(true);
  });
});
