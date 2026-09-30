// The comparison behind scripts/check-radix-overrides.mjs, apart from reading
// package.json and the lockfile: which @radix-ui packages the checked packages
// depend on, and where an override pins one to a version they do not ask for.

/** The packages whose @radix-ui dependencies the overrides have to agree with. */
export const CHECK_PACKAGES = ['@radix-ui/react-dialog', '@radix-ui/react-context-menu', '@radix-ui/react-tooltip'];

/**
 * Every @radix-ui dependency of the checked packages, by name, with who asks
 * for it and at what version. A checked package the lockfile does not list, or
 * one without dependencies, contributes nothing.
 * @param {Record<string, { dependencies?: Record<string, string> }>} lockPackages the lockfile's `packages`
 * @param {string[]} checkPackages
 * @returns {Record<string, { package: string, version: string }[]>}
 */
export function radixDependencies(lockPackages, checkPackages = CHECK_PACKAGES) {
  /** @type {Record<string, { package: string, version: string }[]>} */
  const found = {};
  for (const pkg of checkPackages) {
    const dependencies = lockPackages[`node_modules/${pkg}`]?.dependencies;
    if (!dependencies) continue;
    for (const [dep, version] of Object.entries(dependencies)) {
      if (!dep.startsWith('@radix-ui/')) continue;
      (found[dep] ??= []).push({ package: pkg, version });
    }
  }
  return found;
}

/**
 * Each place an override pins a @radix-ui package to a version a checked
 * package does not ask for. An override of a package no checked package
 * depends on is not a mismatch: there is nothing for it to disagree with.
 * @param {Record<string, string>} overrides package.json's `overrides`
 * @param {Record<string, { dependencies?: Record<string, string> }>} lockPackages
 * @param {string[]} [checkPackages]
 * @returns {{ package: string, override: string, dependency: string, dependentPackage: string }[]}
 */
export function overrideMismatches(overrides, lockPackages, checkPackages = CHECK_PACKAGES) {
  const deps = radixDependencies(lockPackages, checkPackages);
  const issues = [];
  for (const [pkg, override] of Object.entries(overrides)) {
    for (const dep of deps[pkg] ?? []) {
      if (dep.version !== override) {
        issues.push({ package: pkg, override, dependency: dep.version, dependentPackage: dep.package });
      }
    }
  }
  return issues;
}
