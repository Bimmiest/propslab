#!/usr/bin/env node
// Reminds us to move .nvmrc to the newest patch of its Node line (#518).
//
// .nvmrc is an exact version (24.18.1) on purpose: CI, the deploy build and
// local development all run the toolchain that was tested. The cost is that
// Dependabot has nothing to propose — it does not read .nvmrc — so a Node
// security release is picked up when someone happens to remember. This asks
// nodejs.org for the newest release on .nvmrc's major line and says so when
// .nvmrc is behind.
//
// Usage: node scripts/check-node-patch.mjs [--warn-only]
//
//   default      exit 1 when .nvmrc is behind (the scheduled run: a red run
//                is the reminder, and GitHub emails the failure)
//   --warn-only  print a ::warning:: annotation and exit 0 (pull requests,
//                where an unrelated change should not fail on a Node release
//                that shipped this morning)
//
// It looks at the major line .nvmrc names and never at a newer major: moving
// to the next LTS line is a decision (package.json "engines", the CI notes),
// not a patch. An index that cannot be reached is an error, not a pass, except
// under --warn-only: a reminder that silently stops firing is the failure it
// exists to prevent.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INDEX_URL = 'https://nodejs.org/dist/index.json';

/** "v24.18.1" or "24.18.1" -> [24, 18, 1]; null when it is not a plain x.y.z. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative, zero or positive, as Array.prototype.sort wants. */
export function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The newest release on `major`'s line in nodejs.org's index.json, or null.
 * Entries that are not a plain x.y.z (there are none today) are ignored, and
 * the index is not assumed to be sorted.
 */
export function latestOfMajor(index, major) {
  let latest = null;
  for (const entry of index) {
    const version = typeof entry?.version === 'string' ? parseVersion(entry.version) : null;
    if (version?.[0] !== major) continue;
    if (latest === null || compareVersions(version, latest) > 0) latest = version;
  }
  return latest;
}

async function fetchIndex() {
  const response = await fetch(INDEX_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${INDEX_URL} answered ${response.status}`);
  const index = await response.json();
  if (!Array.isArray(index)) throw new Error(`${INDEX_URL} did not return a list of releases`);
  return index;
}

async function main() {
  const warnOnly = process.argv.includes('--warn-only');
  const nvmrc = readFileSync(join(import.meta.dirname, '..', '.nvmrc'), 'utf8');
  const pinned = parseVersion(nvmrc);
  if (!pinned) throw new Error(`.nvmrc must be an exact x.y.z version, found "${nvmrc.trim()}"`);

  const latest = latestOfMajor(await fetchIndex(), pinned[0]);
  if (!latest) throw new Error(`nodejs.org lists no ${pinned[0]}.x release`);

  const pinnedText = pinned.join('.');
  const latestText = latest.join('.');
  if (compareVersions(pinned, latest) >= 0) {
    console.log(`.nvmrc (${pinnedText}) is the newest ${pinned[0]}.x release.`);
    return;
  }

  const message =
    `.nvmrc pins Node ${pinnedText} but ${latestText} is out. Bump .nvmrc to ${latestText} ` +
    '(setup-node reads it in every workflow) and read the release notes for security fixes: ' +
    `https://nodejs.org/en/blog/release/v${latestText}`;
  if (warnOnly) {
    console.log(`::warning title=Node patch available::${message}`);
    return;
  }
  console.log(`::error title=Node patch available::${message}`);
  process.exitCode = 1;
}

// Importing this file (the unit test does) must not fetch anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const text = error instanceof Error ? error.message : String(error);
    // Warn-only means the run must not fail, whatever went wrong.
    const warnOnly = process.argv.includes('--warn-only');
    console.log(`::${warnOnly ? 'warning' : 'error'}::${text}`);
    process.exit(warnOnly ? 0 : 1);
  });
}
