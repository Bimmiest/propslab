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
// The requirements: a required status check, at least one required approving
// review, force-pushes blocked and deletion blocked.
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

/** What classic protection (or its absence) guarantees, as booleans. */
function fromClassic(protection) {
  const statusChecks = protection.required_status_checks;
  // `checks` supersedes the deprecated `contexts`; either being non-empty means
  // something is required. An empty array is truthy but requires nothing.
  const configured = (statusChecks?.checks?.length ?? 0) + (statusChecks?.contexts?.length ?? 0);
  return {
    statusChecks: configured > 0,
    reviews: (protection.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1,
    noForcePush: protection.allow_force_pushes?.enabled === false,
    noDeletion: protection.allow_deletions?.enabled === false,
  };
}

/** What the active rulesets guarantee, as booleans. `rules` is the endpoint's array. */
function fromRulesets(rules) {
  const ofType = (type) => rules.filter((rule) => rule.type === type);
  return {
    statusChecks: ofType('required_status_checks').some(
      (rule) => (rule.parameters?.required_status_checks?.length ?? 0) > 0,
    ),
    reviews: ofType('pull_request').some((rule) => (rule.parameters?.required_approving_review_count ?? 0) >= 1),
    // `non_fast_forward` forbids force-pushes; `deletion` forbids deleting the branch.
    noForcePush: ofType('non_fast_forward').length > 0,
    noDeletion: ofType('deletion').length > 0,
  };
}

const LABELS = {
  statusChecks: 'required status checks',
  reviews: 'at least one required pull request review',
  noForcePush: 'force-pushes blocked',
  noDeletion: 'deletion blocked',
};

const NONE = { statusChecks: false, reviews: false, noForcePush: false, noDeletion: false };

/**
 * Decide whether `main` is protected.
 *
 * @param {object} readers
 * @param {() => Promise<object[]>} readers.getRules   The rulesets endpoint's array; rejects with ApiError.
 * @param {() => Promise<object>}   readers.getClassic The classic protection object; rejects with ApiError.
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
export async function evaluateMainProtection({ getRules, getClassic }) {
  const notes = [];
  const sources = [];
  let fromRules = NONE;
  let fromProtection = NONE;
  let classicUnreadable = false;

  try {
    fromRules = fromRulesets(await getRules());
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

  if (missing.length === 0) return { status: 'ok', missing, sources, notes };
  return { status: classicUnreadable ? 'skipped' : 'incomplete', missing, sources, notes };
}
