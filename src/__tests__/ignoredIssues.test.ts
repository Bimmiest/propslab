import { describe, it, expect } from 'vitest';
import { classifyIssue, ignoredDirectives } from '../../scripts/lib/ignoredIssues.mjs';

// The decisions of scripts/check-ignored-issues.mjs: which directives are
// tracked, and what the API says about the issue behind each. The calls
// themselves are the script's own and need the network.
describe('ignoredDirectives', () => {
  it('lists only the ignored entries, with their issue numbers', () => {
    expect(
      ignoredDirectives({
        SEDCMD: { support: 'full' },
        FOO: { support: 'ignored', issue: 12 },
        BAR: { support: 'partial', issue: 3 },
        BAZ: { support: 'ignored', issue: 40 },
      }),
    ).toEqual([
      { key: 'FOO', issue: 12 },
      { key: 'BAZ', issue: 40 },
    ]);
  });

  it('keeps an ignored entry that names no issue, to be reported', () => {
    expect(ignoredDirectives({ FOO: { support: 'ignored' } })).toEqual([{ key: 'FOO', issue: undefined }]);
  });

  it('is empty when nothing is ignored, the goal state', () => {
    expect(ignoredDirectives({ A: { support: 'full' } })).toEqual([]);
    expect(ignoredDirectives({})).toEqual([]);
  });
});

describe('classifyIssue', () => {
  const answer = (body: object) => ({ ok: true, status: 200, body });

  it('accepts an open issue', () => {
    expect(classifyIssue('FOO', 12, answer({ state: 'open', title: 'Support FOO' }))).toEqual({
      kind: 'ok',
      line: 'FOO → #12 (open)',
    });
  });

  it('calls a closed issue stale, with its title, since the entry promises the limitation is tracked', () => {
    expect(classifyIssue('FOO', 12, answer({ state: 'closed', title: 'Support FOO' }))).toEqual({
      kind: 'stale',
      line: 'FOO: #12 (Support FOO) is closed',
    });
  });

  it('does not take a pull request for an issue, even an open one', () => {
    expect(classifyIssue('FOO', 12, answer({ state: 'open', pull_request: { url: 'x' } }))).toEqual({
      kind: 'unreadable',
      line: 'FOO: #12 is a pull request, not an issue',
    });
  });

  it('cannot conclude from an API error', () => {
    expect(classifyIssue('FOO', 12, { ok: false, status: 404 })).toEqual({
      kind: 'unreadable',
      line: 'FOO: #12 returned HTTP 404',
    });
  });

  it('cannot conclude for an entry that names no issue, and does not need an answer', () => {
    expect(classifyIssue('FOO', undefined, undefined)).toEqual({
      kind: 'unreadable',
      line: 'FOO: no issue number',
    });
  });
});
