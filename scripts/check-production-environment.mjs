// ---------------------------------------------------------------------------
// check-production-environment.mjs
//
// Asserts the settings the deploy workflow's safety rests on, which live in
// repository settings and not in any file:
//
//   1. Deployments are limited to the `main` branch: custom branch policies,
//      exactly one, of type branch, named main, and no tag patterns.
//   2. AZURE_STATIC_WEB_APPS_API_TOKEN is an environment secret of
//      `production` and not a repository secret, which any workflow on any
//      branch could read.
//   3. `main` is protected: changes only through a pull request, the core CI
//      checks required by name, force-pushes and deletion blocked, and no
//      bypass actors on its rulesets (GET /rulesets/{id}), from repository
//      rulesets (GET /rules/branches/main) or classic branch protection
//      (GET /branches/main/protection), either source counting. The decision
//      is scripts/lib/branchProtection.mjs, unit-tested with mocked responses.
//      The rulesets endpoint is readable with the workflow's own token; the
//      classic one needs "Administration: read", which no GITHUB_TOKEN can
//      hold and answers HTTP 403 to. When only that source could have supplied
//      a missing requirement the check is "skipped" with a warning annotation
//      rather than failed or passed; protection expressed as a ruleset is
//      always verified.
//
// The README states these as facts; this is what keeps them facts.
//
// (1) and (3) read with the workflow's GITHUB_TOKEN. (2) lists secret names,
// which needs a token with the "Secrets" repository permission (read), and no
// GITHUB_TOKEN can be granted that; it comes from SECRETS_READ_TOKEN. Listing
// returns names only, never values. Without that token (2) fails rather than
// passing unverified.
// ---------------------------------------------------------------------------

import { ApiError, evaluateMainProtection } from './lib/branchProtection.mjs';

const REPO = process.env.GITHUB_REPOSITORY ?? 'Bimmiest/propslab';
const ENVIRONMENT = 'production';
const SECRET = 'AZURE_STATIC_WEB_APPS_API_TOKEN';

const headersFor = (token) => ({
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const failures = [];

async function get(path, token) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: headersFor(token) });
  if (!response.ok) throw new ApiError(path, response.status);
  return response.json();
}

async function checkBranchRule(token) {
  const environment = await get(`/environments/${ENVIRONMENT}`, token);
  const policy = environment.deployment_branch_policy;
  if (!policy) {
    failures.push(`${ENVIRONMENT} allows deployments from every branch and tag (no deployment branch policy).`);
    return;
  }
  if (policy.protected_branches || !policy.custom_branch_policies) {
    failures.push(`${ENVIRONMENT} uses "protected branches", not "selected branches and tags" limited to main.`);
    return;
  }
  const { branch_policies: rules } = await get(`/environments/${ENVIRONMENT}/deployment-branch-policies`, token);
  const described = rules.map((rule) => `${rule.type ?? 'branch'}:${rule.name}`);
  if (described.length !== 1 || described[0] !== 'branch:main') {
    failures.push(`${ENVIRONMENT} admits ${described.join(', ') || 'nothing'}; expected branch:main only.`);
    return;
  }
  console.log(`  ok  ${ENVIRONMENT} deploys from branch main only`);
}

async function checkSecretScope(token) {
  if (!token) {
    failures.push(
      `SECRETS_READ_TOKEN is not set, so where ${SECRET} is stored could not be checked. ` +
        'Add a fine-grained token for this repository with the "Secrets" permission (read-only) as that repository secret.',
    );
    return;
  }
  const names = (body) => body.secrets.map((secret) => secret.name);
  const inEnvironment = names(await get(`/environments/${ENVIRONMENT}/secrets?per_page=100`, token));
  const inRepository = names(await get('/actions/secrets?per_page=100', token));
  if (!inEnvironment.includes(SECRET)) failures.push(`${SECRET} is not a secret of the ${ENVIRONMENT} environment.`);
  if (inRepository.includes(SECRET)) {
    failures.push(`${SECRET} is also a repository secret, readable by any workflow on any branch; delete that copy.`);
  }
  if (inEnvironment.includes(SECRET) && !inRepository.includes(SECRET)) {
    console.log(`  ok  ${SECRET} is scoped to ${ENVIRONMENT} only`);
  }
}

async function checkBranchProtection(token) {
  if (!token) {
    failures.push(
      'GITHUB_TOKEN is not set, so the branch protection rules for main could not be checked. ' +
        'Add GITHUB_TOKEN with repository permissions to verify branch protection.',
    );
    return;
  }

  const result = await evaluateMainProtection({
    getRules: () => get('/rules/branches/main', token),
    getClassic: () => get('/branches/main/protection', token),
    getRuleset: (id) => get(`/rulesets/${id}`, token),
  });
  const via = result.sources.join(' and ') || 'no readable source';

  if (result.status === 'ok') {
    console.log(
      `  ok  main is protected (${via}): pull request required, CI checks required, no force-push, no deletion, no bypass`,
    );
  } else if (result.status === 'skipped') {
    // The rulesets do not provide everything and the classic rules, which may,
    // need "Administration: read", which no GITHUB_TOKEN holds. Say so loudly
    // without failing a check that cannot see the answer.
    const message = `main branch protection could not be fully verified (${via}); not shown: ${result.missing.join(', ')}. ${result.notes.join('; ')}.`;
    console.log(`  skipped  ${message}`);
    console.log(`::warning title=main branch protection unverified::${message}`);
  } else {
    failures.push(
      `main branch protection is incomplete (${via}); missing: ${result.missing.join(', ')}. ` +
        'Add a ruleset or branch protection rule for main that requires them.',
    );
  }
}

for (const [name, check] of [
  ['branch rule', () => checkBranchRule(process.env.GITHUB_TOKEN)],
  ['secret scope', () => checkSecretScope(process.env.SECRETS_READ_TOKEN)],
  ['branch protection', () => checkBranchProtection(process.env.GITHUB_TOKEN)],
]) {
  try {
    await check();
  } catch (error) {
    failures.push(`Could not check the ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error(`\nThe ${ENVIRONMENT} environment is not configured as the deploy workflow requires:`);
  for (const line of failures) console.error(`  ${line}`);
  console.error('\nSee the comment above the `deploy` job in .github/workflows/azure-static-web-apps.yml.');
  process.exit(1);
}
