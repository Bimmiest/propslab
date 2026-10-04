// The decision behind the `main` protection check of
// scripts/check-production-environment.mjs (#509, #520), fed mocked API
// responses. Payload shapes follow GitHub's REST reference: "Get rules for a
// branch" (an array of { type, parameters, ruleset_id }), "Get a repository
// ruleset" and "Get branch protection".
import { describe, it, expect } from 'vitest';
import { ApiError, evaluateMainProtection, REQUIRED_CHECKS } from '../../scripts/lib/branchProtection.mjs';

const RULESET = 18484915;
const checks = (...names: string[]) => names.map((context) => ({ context, integration_id: 15368 }));

// main's ruleset as the API returned it on 2026-10-04: a pull request with no
// approvals (a sole maintainer cannot approve their own PRs), squash only, the
// CI checks and the two Security workflow checks (#549), no force-push, no
// deletion.
const liveRules = [
  { type: 'deletion', ruleset_id: RULESET },
  { type: 'non_fast_forward', ruleset_id: RULESET },
  {
    type: 'pull_request',
    ruleset_id: RULESET,
    parameters: { required_approving_review_count: 0, allowed_merge_methods: ['squash'] },
  },
  {
    type: 'required_status_checks',
    ruleset_id: RULESET,
    parameters: {
      required_status_checks: checks(
        'ci',
        'audit',
        'mcp-server',
        'workflow-lint',
        'Analyze (actions)',
        'Analyze (javascript-typescript)',
        'security / gitleaks',
        'security / trivy',
      ),
    },
  },
];
const noBypass = { id: RULESET, bypass_actors: [] };

const fullClassic = {
  required_status_checks: { strict: false, contexts: [], checks: checks(...REQUIRED_CHECKS) },
  required_pull_request_reviews: { required_approving_review_count: 0 },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  enforce_admins: { enabled: true },
};

const ok =
  <T>(value: T) =>
  () =>
    Promise.resolve(value);
const fails = (status: number) => () => Promise.reject(new ApiError('/x', status));
const without = (type: string) => liveRules.filter((rule) => rule.type !== type);

describe('evaluateMainProtection', () => {
  it("accepts main's live ruleset", async () => {
    const result = await evaluateMainProtection({
      getRules: ok(liveRules),
      getClassic: fails(403),
      getRuleset: ok(noBypass),
    });
    expect(result).toMatchObject({ status: 'ok', missing: [], sources: ['rulesets'] });
  });

  it('asks for a pull request, not for approvals', async () => {
    const result = await evaluateMainProtection({
      getRules: ok(without('pull_request')),
      getClassic: fails(404),
      getRuleset: ok(noBypass),
    });
    expect(result).toMatchObject({ status: 'incomplete', missing: ['changes only through a pull request'] });
  });

  it('names each core CI check that is not required', async () => {
    const rules = [
      ...without('required_status_checks'),
      {
        type: 'required_status_checks',
        ruleset_id: RULESET,
        parameters: { required_status_checks: checks('ci', 'Analyze (actions)') },
      },
    ];
    const result = await evaluateMainProtection({
      getRules: ok(rules),
      getClassic: fails(404),
      getRuleset: ok(noBypass),
    });
    expect(result.missing).toEqual([
      'required status checks: audit, mcp-server, workflow-lint, security / gitleaks, security / trivy',
    ]);
  });

  it('treats an empty required-status-checks list as none required', async () => {
    const rules = [
      ...without('required_status_checks'),
      { type: 'required_status_checks', ruleset_id: RULESET, parameters: { required_status_checks: [] } },
    ];
    const result = await evaluateMainProtection({
      getRules: ok(rules),
      getClassic: fails(404),
      getRuleset: ok(noBypass),
    });
    expect(result.missing).toEqual([`required status checks: ${REQUIRED_CHECKS.join(', ')}`]);
  });

  it('fails a ruleset that someone can bypass, and says who', async () => {
    const result = await evaluateMainProtection({
      getRules: ok(liveRules),
      getClassic: fails(404),
      getRuleset: ok({ id: RULESET, bypass_actors: [{ actor_type: 'RepositoryRole', bypass_mode: 'always' }] }),
    });
    expect(result.missing).toEqual(['no bypass actors']);
    expect(result.notes.join(' ')).toContain(`ruleset ${RULESET} lets 1 actor(s) bypass it`);
  });

  it('does not count a bypass list the token cannot see', async () => {
    const result = await evaluateMainProtection({
      getRules: ok(liveRules),
      getClassic: fails(404),
      getRuleset: ok({ id: RULESET }),
    });
    expect(result.missing).toEqual(['no bypass actors']);
    expect(result.notes.join(' ')).toContain('not visible');
  });

  it('reads every ruleset that applies to main, once each', async () => {
    const other = 99;
    const rules = [...liveRules, { type: 'deletion', ruleset_id: other }];
    const read: number[] = [];
    const result = await evaluateMainProtection({
      getRules: ok(rules),
      getClassic: fails(404),
      getRuleset: (id: number) => {
        read.push(id);
        return Promise.resolve(id === other ? { id, bypass_actors: [{ actor_type: 'Team' }] } : noBypass);
      },
    });
    expect(read).toEqual([RULESET, other]);
    expect(result.missing).toEqual(['no bypass actors']);
  });

  it('accepts protection that comes from classic rules alone', async () => {
    const result = await evaluateMainProtection({ getRules: ok([]), getClassic: ok(fullClassic) });
    expect(result).toMatchObject({ status: 'ok', missing: [], sources: ['rulesets', 'classic branch protection'] });
  });

  it('reads the classic rules the same way: a pull request, the named checks, admins included', async () => {
    const classic = {
      required_status_checks: { strict: false, contexts: ['ci'] },
      allow_force_pushes: { enabled: true },
      allow_deletions: { enabled: false },
      enforce_admins: { enabled: false },
    };
    const result = await evaluateMainProtection({ getRules: ok([]), getClassic: ok(classic) });
    expect(result.missing).toEqual([
      'changes only through a pull request',
      'force-pushes blocked',
      'no bypass actors',
      'required status checks: audit, mcp-server, workflow-lint, security / gitleaks, security / trivy',
    ]);
  });

  it('counts a check required by either source', async () => {
    const rules = [
      ...without('required_status_checks'),
      {
        type: 'required_status_checks',
        ruleset_id: RULESET,
        parameters: { required_status_checks: checks('ci', 'audit') },
      },
    ];
    const classic = {
      ...fullClassic,
      required_status_checks: { contexts: ['mcp-server', 'workflow-lint', 'security / gitleaks', 'security / trivy'] },
    };
    const result = await evaluateMainProtection({
      getRules: ok(rules),
      getClassic: ok(classic),
      getRuleset: ok(noBypass),
    });
    expect(result.status).toBe('ok');
  });

  it('fails when there are no rulesets and no classic protection', async () => {
    const result = await evaluateMainProtection({ getRules: ok([]), getClassic: fails(404) });
    expect(result.status).toBe('incomplete');
    expect(result.missing).toHaveLength(5);
  });

  describe('when the classic protection cannot be read (HTTP 403 under GITHUB_TOKEN)', () => {
    it('is skipped, not failed, when something is missing that the classic rules might provide', async () => {
      const result = await evaluateMainProtection({ getRules: ok([]), getClassic: fails(403) });
      expect(result.status).toBe('skipped');
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

  it('rethrows any other API failure for the caller to report', async () => {
    await expect(evaluateMainProtection({ getRules: fails(500), getClassic: fails(404) })).rejects.toMatchObject({
      status: 500,
    });
    await expect(
      evaluateMainProtection({ getRules: ok(liveRules), getClassic: fails(404), getRuleset: fails(502) }),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      evaluateMainProtection({ getRules: ok([]), getClassic: () => Promise.reject(new Error('network down')) }),
    ).rejects.toThrow('network down');
  });
});
