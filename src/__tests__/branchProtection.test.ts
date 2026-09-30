// The decision behind the `main` protection check of
// scripts/check-production-environment.mjs (#509, #520), fed mocked API
// responses. Payload shapes follow GitHub's REST reference: "Get rules for a
// branch" (an array of { type, parameters }) and "Get branch protection".
import { describe, it, expect } from 'vitest';
import { ApiError, evaluateMainProtection } from '../../scripts/lib/branchProtection.mjs';

const fullRules = [
  { type: 'deletion' },
  { type: 'non_fast_forward' },
  { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
  { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } },
];

const fullClassic = {
  required_status_checks: { strict: true, contexts: ['ci'], checks: [{ context: 'ci', app_id: null }] },
  required_pull_request_reviews: { required_approving_review_count: 1 },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
};

const ok = <T>(value: T) => () => Promise.resolve(value);
const fails = (status: number) => () => Promise.reject(new ApiError('/x', status));

describe('evaluateMainProtection', () => {
  it('accepts protection that comes from rulesets alone', async () => {
    const result = await evaluateMainProtection({ getRules: ok(fullRules), getClassic: fails(404) });
    expect(result).toMatchObject({ status: 'ok', missing: [], sources: ['rulesets'] });
  });

  it('accepts protection that comes from classic rules alone', async () => {
    const result = await evaluateMainProtection({ getRules: ok([]), getClassic: ok(fullClassic) });
    expect(result).toMatchObject({ status: 'ok', missing: [], sources: ['rulesets', 'classic branch protection'] });
  });

  it('accepts requirements split between the two sources', async () => {
    const result = await evaluateMainProtection({
      getRules: ok([{ type: 'deletion' }, { type: 'non_fast_forward' }]),
      getClassic: ok({ ...fullClassic, allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true } }),
    });
    expect(result.status).toBe('ok');
  });

  it('names what is missing when neither source has it', async () => {
    const result = await evaluateMainProtection({ getRules: ok([{ type: 'deletion' }]), getClassic: fails(404) });
    expect(result.status).toBe('incomplete');
    expect(result.missing).toEqual([
      'required status checks',
      'at least one required pull request review',
      'force-pushes blocked',
    ]);
  });

  it('fails when there are no rulesets and no classic protection', async () => {
    const result = await evaluateMainProtection({ getRules: ok([]), getClassic: fails(404) });
    expect(result.status).toBe('incomplete');
    expect(result.missing).toHaveLength(4);
  });

  it('treats an empty required-status-checks list as none configured', async () => {
    // GitHub returns `checks: []` (truthy) when protection exists but requires nothing.
    const classic = { ...fullClassic, required_status_checks: { strict: false, contexts: [], checks: [] } };
    const rules = [
      { type: 'required_status_checks', parameters: { required_status_checks: [] } },
      { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
      { type: 'non_fast_forward' },
      { type: 'deletion' },
    ];
    for (const getRules of [ok([]), ok(rules)]) {
      const result = await evaluateMainProtection({ getRules, getClassic: ok(classic) });
      expect(result.missing).toEqual(['required status checks']);
    }
  });

  it('counts the deprecated contexts list when checks is absent', async () => {
    const classic = { ...fullClassic, required_status_checks: { strict: true, contexts: ['ci'] } };
    expect((await evaluateMainProtection({ getRules: ok([]), getClassic: ok(classic) })).status).toBe('ok');
  });

  it('requires at least one approving review, not merely a review rule', async () => {
    const rules = fullRules.map((rule) =>
      rule.type === 'pull_request' ? { type: 'pull_request', parameters: { required_approving_review_count: 0 } } : rule,
    );
    const classic = { ...fullClassic, required_pull_request_reviews: { required_approving_review_count: 0 } };
    for (const [getRules, getClassic] of [
      [ok(rules), fails(404)],
      [ok([]), ok(classic)],
    ] as const) {
      const result = await evaluateMainProtection({ getRules, getClassic });
      expect(result.missing).toEqual(['at least one required pull request review']);
    }
  });

  it('requires force-push and deletion to be blocked in classic protection', async () => {
    const classic = { ...fullClassic, allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true } };
    const result = await evaluateMainProtection({ getRules: ok([]), getClassic: ok(classic) });
    expect(result.missing).toEqual(['force-pushes blocked', 'deletion blocked']);
  });

  describe('when the classic protection cannot be read (HTTP 403 under GITHUB_TOKEN)', () => {
    it('passes when the rulesets already provide everything', async () => {
      const result = await evaluateMainProtection({ getRules: ok(fullRules), getClassic: fails(403) });
      expect(result).toMatchObject({ status: 'ok', sources: ['rulesets'] });
    });

    it('is skipped, not failed, when something is missing that the classic rules might provide', async () => {
      const result = await evaluateMainProtection({ getRules: ok([]), getClassic: fails(403) });
      expect(result.status).toBe('skipped');
      expect(result.missing).toHaveLength(4);
      expect(result.notes.join(' ')).toContain('Administration: read');
    });

    it('is matched on the structured status, whatever the message says', async () => {
      const error = new ApiError('/branches/main/protection', 403);
      expect(error.message).toBe('GET /branches/main/protection returned HTTP 403');
      const result = await evaluateMainProtection({ getRules: ok([]), getClassic: () => Promise.reject(error) });
      expect(result.status).toBe('skipped');
    });
  });

  it('falls back to classic protection when the rulesets are not readable', async () => {
    for (const status of [403, 404]) {
      const result = await evaluateMainProtection({ getRules: fails(status), getClassic: ok(fullClassic) });
      expect(result).toMatchObject({ status: 'ok', sources: ['classic branch protection'] });
      expect(result.notes[0]).toContain(`HTTP ${status}`);
    }
  });

  it('is incomplete when the rulesets are unreadable and classic protection is confirmed absent', async () => {
    const result = await evaluateMainProtection({ getRules: fails(403), getClassic: fails(404) });
    expect(result.status).toBe('incomplete');
  });

  it('rethrows any other API failure for the caller to report', async () => {
    await expect(evaluateMainProtection({ getRules: fails(500), getClassic: fails(404) })).rejects.toMatchObject({
      status: 500,
    });
    await expect(evaluateMainProtection({ getRules: ok([]), getClassic: fails(502) })).rejects.toMatchObject({
      status: 502,
    });
    await expect(
      evaluateMainProtection({ getRules: ok([]), getClassic: () => Promise.reject(new Error('network down')) }),
    ).rejects.toThrow('network down');
  });
});
