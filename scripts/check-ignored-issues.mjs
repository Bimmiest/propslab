// ---------------------------------------------------------------------------
// check-ignored-issues.mjs
//
// Asserts that every `ignored` directive's tracking issue is still open.
//
// `directiveSupport.test.ts` already asserts that an `ignored` entry *has* an
// issue number; this checks the issue is still open. A reader following a
// closed issue's link to understand a limitation finds a fixed bug and a
// preview that still ignores their config.
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
import { classifyIssue, ignoredDirectives } from './lib/ignoredIssues.mjs';

const REPO = process.env.GITHUB_REPOSITORY ?? 'Bimmiest/propslab';
const token = process.env.GITHUB_TOKEN;

const tracked = ignoredDirectives(DIRECTIVE_SUPPORT);

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
  let response;
  if (issue !== undefined) {
    const raw = await fetch(`https://api.github.com/repos/${REPO}/issues/${issue}`, { headers });
    response = { ok: raw.ok, status: raw.status, ...(raw.ok ? { body: await raw.json() } : {}) };
  }
  const { kind, line } = classifyIssue(key, issue, response);
  if (kind === 'ok') console.log(`  ok  ${line}`);
  else if (kind === 'stale') stale.push(line);
  else unreadable.push(line);
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
