// The decisions behind scripts/check-ignored-issues.mjs, apart from calling the
// GitHub API: which directives are tracked, and what an API answer says about
// the issue that tracks one.

/**
 * The `ignored` directives of the support table, each with its tracking issue
 * (undefined when the entry names none).
 * @param {Record<string, { support: string, issue?: number }>} table
 * @returns {{ key: string, issue: number | undefined }[]}
 */
export function ignoredDirectives(table) {
  return Object.entries(table)
    .filter(([, entry]) => entry.support === 'ignored')
    .map(([key, entry]) => ({ key, issue: entry.issue }));
}

/**
 * What one directive's tracking issue turned out to be.
 *
 * - `ok`: an open issue.
 * - `stale`: the issue is closed (or otherwise not open): the entry promises
 *   the limitation is tracked, and it is not.
 * - `unreadable`: nothing could be concluded: no issue number, an API error, or
 *   a pull request. An `ignored` entry must name the issue arguing for the
 *   work, not the pull request that happened to touch it, since a merged PR
 *   reads as "done".
 *
 * @param {string} key
 * @param {number | undefined} issue
 * @param {{ ok: boolean, status: number, body?: { state?: string, title?: string, pull_request?: unknown } } | undefined} response
 *   the API's answer for the issue; not needed when there is no issue number
 * @returns {{ kind: 'ok' | 'stale' | 'unreadable', line: string }}
 */
export function classifyIssue(key, issue, response) {
  if (issue === undefined) {
    // directiveSupport.test.ts fails on this already; treat it as unreadable
    // here rather than silently passing a directive nobody is tracking.
    return { kind: 'unreadable', line: `${key}: no issue number` };
  }
  if (!response?.ok) {
    return { kind: 'unreadable', line: `${key}: #${issue} returned HTTP ${response?.status}` };
  }
  const { state, title, pull_request: pullRequest } = response.body ?? {};
  if (pullRequest) return { kind: 'unreadable', line: `${key}: #${issue} is a pull request, not an issue` };
  if (state !== 'open') return { kind: 'stale', line: `${key}: #${issue} (${title}) is ${state}` };
  return { kind: 'ok', line: `${key} → #${issue} (open)` };
}
