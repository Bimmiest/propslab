export const CHECK_PACKAGES: string[];
type LockPackages = Record<string, { dependencies?: Record<string, string> }>;
export function radixDependencies(
  lockPackages: LockPackages,
  checkPackages?: string[],
): Record<string, { package: string; version: string }[]>;
export function overrideMismatches(
  overrides: Record<string, string>,
  lockPackages: LockPackages,
  checkPackages?: string[],
): { package: string; override: string; dependency: string; dependentPackage: string }[];
