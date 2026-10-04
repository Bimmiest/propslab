// ---------------------------------------------------------------------------
// branchProtection.mjs
//
// The pure half of the `main` protection check in
// check-production-environment.mjs: given what the GitHub API returned, decide
// whether `main` is protected as the deploy's trust model requires. It performs
// no I/O of its own; the caller injects the two readers, so the decision can be
// tested with mocked responses (src/__tests__/branchProtection.test.ts).
//
// Protection can come from two places, and either is enough for a requirement:
//
//   - Repository rulesets, read with GET /repos/{owner}/{repo}/rules/branches/main.
//     It lists the active rules that apply to the branch and needs only read
//     access to the repository, so the workflow's own GITHUB_TOKEN can call it.
//   - Classic branch protection, read with GET /repos/{owner}/{repo}/branches/main/protection.
//     GitHub requires the "Administration: read" permission for it, which no
//     GITHUB_TOKEN can hold, so under the workflow token it answers HTTP 403.
//
// The requirements: changes arrive through a pull request (no approval count is
// required: a sole maintainer cannot approve their own PRs), the core CI checks
// are required by name, force-pushes and deletion are blocked, and nobody can
// bypass the rulesets that say so.
// ---------------------------------------------------------------------------

/** An HTTP failure from the GitHub API, carrying the status so callers never parse messages. */
export class ApiError extends Error {
  /**
   * @param {string} path   The request path, for the message.
   * @param {number} status The HTTP status.
   */
  constructor(path, status) {
    super(`GET ${path} returned HTTP ${status}`);
    this.name = 'ApiError';
    this.path = path;
    this.status = status;
  }
}

/** Whether `error` is an ApiError with one of `statuses`. */
function hasStatus(error, ...statuses) {
  return error instanceof ApiError && statuses.includes(error.status);
}

/**
 * The checks `main` must require by name: the jobs of ci.yml that run on every
 * pull request, and the two jobs of the Security workflow (#549), whose check
 * names carry the calling job's name because the workflow is a reusable one.
 */
export const REQUIRED_CHECKS = [
  'ci',
  'audit',
  'mcp-server',
  'workflow-lint',
  'security / gitleaks',
  'security / trivy',
];

/** The required checks among `names` that are missing. */
function missingChecks(names) {
  return REQUIRED_CHECKS.filter((name) => !names.includes(name));
}

/** What classic protection (or its absence) guarantees. */
function fromClassic(protection) {
  const statusChecks = protection.required_status_checks;
  // `checks` supersedes the deprecated `contexts`; read both.
  const names = [...(statusChecks?.checks ?? []).map((c) => c.context), ...(statusChecks?.contexts ?? [])];
  return {
    // Classic protection expresses "require a pull request" as the presence of
    // required_pull_request_reviews, whatever its approval count.
    pullRequest: protection.required_pull_request_reviews != null,
    checksMissing: missingChecks(names),
    noForcePush: protection.allow_force_pushes?.enabled === false,
    noDeletion: protection.allow_deletions?.enabled === false,
    noBypass: protection.enforce_admins?.enabled === true,
  };
}

/** What the active rulesets guarantee. `rules` is the endpoint's array. */
function fromRulesets(rules) {
  const ofType = (type) => rules.filter((rule) => rule.type === type);
  const names = ofType('required_status_checks').flatMap((rule) =>
    (rule.parameters?.required_status_checks ?? []).map((c) => c.context),
  );
  return {
    pullRequest: ofType('pull_request').length > 0,
    checksMissing: missingChecks(names),
    // `non_fast_forward` forbids force-pushes; `deletion` forbids deleting the branch.
    noForcePush: ofType('non_fast_forward').length > 0,
    noDeletion: ofType('deletion').length > 0,
    noBypass: false, // decided from the rulesets themselves, below
  };
}

const LABELS = {
  pullRequest: 'changes only through a pull request',
  noForcePush: 'force-pushes blocked',
  noDeletion: 'deletion blocked',
  noBypass: 'no bypass actors',
};

const NONE = {
  pullRequest: false,
  checksMissing: REQUIRED_CHECKS,
  noForcePush: false,
  noDeletion: false,
  noBypass: false,
};

/**
 * Decide whether `main` is protected.
 *
 * @param {object} readers
 * @param {() => Promise<object[]>} readers.getRules   The rulesets endpoint's array; rejects with ApiError.
 * @param {() => Promise<object>}   readers.getClassic The classic protection object; rejects with ApiError.
 * @param {(id: number) => Promise<object>} [readers.getRuleset] One ruleset by id, for its `bypass_actors`.
 * @returns {Promise<{
 *   status: 'ok' | 'incomplete' | 'skipped',
 *   missing: string[],
 *   sources: string[],
 *   notes: string[],
 * }>}
 *   `ok`: every requirement is met by rulesets, classic protection or the two together.
 *   `incomplete`: something is missing and nothing prevented reading the sources.
 *   `skipped`: something is missing, but the classic protection could not be read
 *   (HTTP 403), so it may be what provides it. A warning, not a verdict.
 *   Any other API failure is rethrown for the caller to report.
 */
export async function evaluateMainProtection({ getRules, getClassic, getRuleset }) {
  const notes = [];
  const sources = [];
  let fromRules = NONE;
  let fromProtection = NONE;
  let classicUnreadable = false;

  try {
    const rules = await getRules();
    fromRules = fromRulesets(rules);
    fromRules.noBypass = await rulesetsHaveNoBypass(rules, getRuleset, notes);
    sources.push('rulesets');
  } catch (error) {
    // No visible rules (404) or no access to them (403): fall back to classic protection.
    if (!hasStatus(error, 403, 404)) throw error;
    notes.push(`rulesets could not be read (HTTP ${error.status})`);
  }

  try {
    fromProtection = fromClassic(await getClassic());
    sources.push('classic branch protection');
  } catch (error) {
    if (hasStatus(error, 404)) {
      // "Branch not protected": no classic rule, which is an answer.
    } else if (hasStatus(error, 403)) {
      classicUnreadable = true;
      notes.push('classic branch protection needs a token with "Administration: read" and was not readable (HTTP 403)');
    } else {
      throw error;
    }
  }

  const missing = Object.keys(LABELS)
    .filter((key) => !fromRules[key] && !fromProtection[key])
    .map((key) => LABELS[key]);
  // A check counts if either source requires it.
  const checks = fromRules.checksMissing.filter((name) => fromProtection.checksMissing.includes(name));
  if (checks.length > 0) missing.push(`required status checks: ${checks.join(', ')}`);

  if (missing.length === 0) return { status: 'ok', missing, sources, notes };
  return { status: classicUnreadable ? 'skipped' : 'incomplete', missing, sources, notes };
}

/**
 * Whether no ruleset that applies to `main` has bypass actors. The rules
 * endpoint names each rule's ruleset; each is read for its `bypass_actors`.
 * A ruleset whose list is not visible to the token is noted and not counted.
 */
async function rulesetsHaveNoBypass(rules, getRuleset, notes) {
  const ids = [...new Set(rules.map((rule) => rule.ruleset_id).filter((id) => id !== undefined))];
  if (ids.length === 0 || !getRuleset) return false;
  for (const id of ids) {
    const ruleset = await getRuleset(id);
    if (!Array.isArray(ruleset.bypass_actors)) {
      notes.push(`ruleset ${id}'s bypass list is not visible to this token`);
      return false;
    }
    if (ruleset.bypass_actors.length > 0) {
      notes.push(`ruleset ${id} lets ${ruleset.bypass_actors.length} actor(s) bypass it`);
      return false;
    }
  }
  return true;
}
