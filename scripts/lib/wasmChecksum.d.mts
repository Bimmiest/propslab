export function expectedChecksum(sums: string, name: string): string | undefined;
export function verifyChecksum(
  bytes: Uint8Array,
  sums: string,
  name: string,
): { status: 'ok' | 'no-entry' | 'mismatch'; expected?: string; actual: string };
