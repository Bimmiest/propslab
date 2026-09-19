// ---------------------------------------------------------------------------
// check-ignored-issues.mjs
//
// Asserts that every `ignored` directive's tracking issue is still open.
//
// `directiveSupport.test.ts` already asserts that an `ignored` entry *has* an
// issue number. Nothing asserted the issue was still open, and that is exactly
// how the roster went stale: `TZ_ALIAS` named #159 — which closed when the TZ
// work landed — for months after that work had landed without it. A reader
// following the link to understand a limitation found a fixed bug and a preview
// that still ignored their config, which is the declared-surface mechanism
// (#153) failing in the one way it exists to prevent.
//
// This lives outside `npm test` on purpose. The suite is deliberately hermetic
// — it runs wherever the engine runs, with no filesystem or network — and a
// check that calls the GitHub API cannot join it without giving that up. So it
// runs on a schedule instead, where being slow and online costs nothing.
//
// Reads the table through Node's native type stripping: directiveSupport.ts has
// no imports, so it needs no build step and no dependency to load here.
// ---------------------------------------------------------------------------

import { DIRECTIVE_SUPPORT } from '../src/engine/directiveSupport.ts';

const REPO = process.env.GITHUB_REPOSITORY ?? 'Bimmiest/propslab';
const token = process.env.GITHUB_TOKEN;

const tracked = Object.entries(DIRECTIVE_SUPPORT)
  .filter(([, entry]) => entry.support === 'ignored')
  .map(([key, entry]) => ({ key, issue: entry.issue }));

if (tracked.length === 0) {
  // Not a special case to apologise for: an empty roster is the goal state, and
  // the check still has to run so it starts failing again the day one returns.
  console.log('No `ignored` directives are declared — nothing to verify.');
  process.exit(0);
}

const headers = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

const stale = [];
const unreadable = [];

for (const { key, issue } of tracked) {
  if (issue === undefined) {
    // directiveSupport.test.ts fails on this already; treat it as unreadable
    // here rather than silently passing a directive nobody is tracking.
    unreadable.push(`${key}: no issue number`);
    continue;
  }

  const response = await fetch(`https://api.github.com/repos/${REPO}/issues/${issue}`, { headers });
  if (!response.ok) {
    unreadable.push(`${key}: #${issue} returned HTTP ${response.status}`);
    continue;
  }

  const { state, title, pull_request: pullRequest } = await response.json();
  if (pullRequest) {
    // An `ignored` entry must name the issue arguing for the work, not the pull
    // request that happened to touch it — a merged PR reads as "done".
    unreadable.push(`${key}: #${issue} is a pull request, not an issue`);
  } else if (state !== 'open') {
    stale.push(`${key}: #${issue} (${title}) is ${state}`);
  } else {
    console.log(`  ok  ${key} → #${issue} (open)`);
  }
}

if (unreadable.length > 0) {
  console.error('\nCould not verify:');
  for (const line of unreadable) console.error(`  ${line}`);
}

if (stale.length > 0) {
  console.error('\nThese `ignored` directives point at a closed issue:');
  for (const line of stale) console.error(`  ${line}`);
  console.error(
    '\nAn `ignored` entry is a promise that the limitation is tracked somewhere a\n' +
      'reader can follow. Either reopen the issue, repoint the entry at the one that\n' +
      'now tracks the work, or implement the directive and reclassify it.',
  );
}

process.exit(stale.length > 0 || unreadable.length > 0 ? 1 : 0);
