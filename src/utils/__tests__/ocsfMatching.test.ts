import { describe, expect, it } from 'vitest';
import { validateOcsfCoverage, type OcsfCoverageResult } from 'propslab-engine';
import { declaredClassUids, fitOf, OCSF_MATCH_THRESHOLD_PERCENT, rankClasses } from '../ocsfMatching';

const resultFor = (fields: string[], name: string): OcsfCoverageResult => {
  const found = validateOcsfCoverage(fields).find((r) => r.ocsfClass.name === name);
  if (!found) throw new Error(`no class ${name}`);
  return found;
};
const NONE = new Set<number>();

describe('fitOf (#892)', () => {
  it('counts the required attributes that the class does not take from the base event', () => {
    // Authentication requires `user` beside the seven attributes that each class requires.
    const fit = fitOf(resultFor(['user', 'time', 'class_uid'], 'authentication'), NONE);
    expect(fit.key).toEqual(['user']);
    expect(fit.keyPresent).toEqual(['user']);
    expect(fit.keyPercent).toBe(100);
    expect(fit.matches).toBe(true);
  });

  it('does not match on the attributes of the base event alone', () => {
    const fit = fitOf(
      resultFor(['activity_id', 'time', 'class_uid', 'severity_id', 'message'], 'authentication'),
      NONE,
    );
    expect(fit.keyPresent).toEqual([]);
    expect(fit.matches).toBe(false);
  });

  it('takes the recommended attributes of a class that requires none of its own', () => {
    const fit = fitOf(
      resultFor(['src_endpoint.ip', 'dst_endpoint.ip', 'connection_info.protocol_name'], 'network_activity'),
      NONE,
    );
    expect(fit.key).not.toContain('message');
    expect(fit.key).toEqual(expect.arrayContaining(['src_endpoint', 'dst_endpoint', 'connection_info']));
    expect(fit.keyPresent).toEqual(expect.arrayContaining(['src_endpoint', 'dst_endpoint', 'connection_info']));
  });

  it(`matches at ${OCSF_MATCH_THRESHOLD_PERCENT}%, not below`, () => {
    // Process Activity requires actor, device and process of its own.
    expect(fitOf(resultFor(['actor.user.name'], 'process_activity'), NONE)).toMatchObject({
      keyPercent: 33,
      matches: false,
    });
    expect(fitOf(resultFor(['actor.user.name', 'process.pid'], 'process_activity'), NONE)).toMatchObject({
      keyPercent: 67,
      matches: true,
    });
  });

  it('gives a share of 0, and no match, to a class with no key attribute', () => {
    // Application Error has no required or recommended attribute of its own.
    const fit = fitOf(resultFor(['message'], 'application_error'), NONE);
    expect(fit).toMatchObject({ key: [], keyPercent: 0, matches: false, declared: false });
  });

  it('matches a class that the events declare, whatever the fit', () => {
    const fit = fitOf(resultFor([], 'application_error'), new Set([6008]));
    expect(fit).toMatchObject({ declared: true, matches: true });
  });
});

describe('declaredClassUids', () => {
  const events: { fields: Record<string, string | string[]> }[] = [
    { fields: { class_uid: '3002' } },
    { fields: { class_uid: ['4001', ' 4002 '] } },
    { fields: { class_uid: 'Authentication' } },
    { fields: { class_uid: '' } },
    { fields: { other: '1' } },
  ];

  it('gives the whole-number values of the class_uid field, and skips the others', () => {
    expect([...declaredClassUids(events, ['class_uid', 'other'])]).toEqual([3002, 4001, 4002]);
  });

  it('reads no event when no event has the field', () => {
    expect(declaredClassUids(events, ['other']).size).toBe(0);
  });
});

describe('rankClasses', () => {
  const rank = (fields: string[], declared = NONE) =>
    rankClasses(validateOcsfCoverage(fields), declared).map((f) => f.result.ocsfClass.name);

  it('puts a declared class first, then the matching classes, the best fit at the top', () => {
    const fields = ['user', 'src_endpoint.ip', 'actor.user.name', 'device.hostname', 'process.pid'];
    const order = rank(fields, new Set([4001]));
    expect(order[0]).toBe('network_activity');
    // Process Activity has all three of its key attributes; Authentication has its one.
    expect(order.indexOf('process_activity')).toBeLessThan(order.indexOf('authentication'));
    expect(order.indexOf('authentication')).toBeLessThan(order.indexOf('application_error'));
  });

  it('keeps the class_uid order for a tie, and returns a new array', () => {
    const results = validateOcsfCoverage([]);
    const ranked = rankClasses(results, NONE);
    expect(ranked.map((f) => f.result)).toEqual(results);
    expect(ranked.map((f) => f.result)).not.toBe(results);
  });

  it('breaks a tie in the key attributes with the share of all attributes', () => {
    // Authentication and User Inventory each have `user` as their one key
    // attribute. `is_mfa` and `logon_type` are recommended in Authentication only.
    const order = rank(['user', 'is_mfa', 'logon_type']);
    expect(order.indexOf('authentication')).toBeLessThan(order.indexOf('user_inventory'));
    const fits = rankClasses(validateOcsfCoverage(['user', 'is_mfa', 'logon_type']), NONE);
    const auth = fits.find((f) => f.result.ocsfClass.name === 'authentication')!;
    const inventory = fits.find((f) => f.result.ocsfClass.name === 'user_inventory')!;
    expect([auth.keyPresent.length, auth.keyPercent]).toEqual([inventory.keyPresent.length, inventory.keyPercent]);
    expect(auth.result.totalPercent).toBeGreaterThan(inventory.result.totalPercent);
  });
});
