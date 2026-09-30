export function ignoredDirectives(
  table: Record<string, { support: string; issue?: number }>,
): { key: string; issue: number | undefined }[];
export function classifyIssue(
  key: string,
  issue: number | undefined,
  response?: {
    ok: boolean;
    status: number;
    body?: { state?: string; title?: string; pull_request?: unknown };
  },
): { kind: 'ok' | 'stale' | 'unreadable'; line: string };
