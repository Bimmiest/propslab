// The comparison behind scripts/check-radix-overrides.mjs, apart from reading
// package.json and the lockfile: which @radix-ui packages the checked packages
// depend on, and where an override pins one to a version they do not ask for.

/**
 * Every @radix-ui package installed at the top of node_modules: the packages
 * whose @radix-ui dependencies the overrides have to agree with. All of them,
 * not only the three the app imports: an override such as
 * `react-use-callback-ref` is asked for only by other Radix packages, and
 * checked against the app's three alone it was never compared at all (#622).
 * @param {Record<string, unknown>} lockPackages the lockfile's `packages`
 * @returns {string[]}
 */
export function radixPackages(lockPackages) {
  return Object.keys(lockPackages)
    .filter((key) => /^node_modules\/@radix-ui\/[^/]+$/.test(key))
    .map((key) => key.slice('node_modules/'.length));
}

/**
 * Every @radix-ui dependency of the checked packages, by name, with who asks
 * for it and at what version. A checked package the lockfile does not list, or
 * one without dependencies, contributes nothing.
 * @param {Record<string, { dependencies?: Record<string, string> }>} lockPackages the lockfile's `packages`
 * @param {string[]} [checkPackages] every top-level @radix-ui package by default
 * @returns {Record<string, { package: string, version: string }[]>}
 */
export function radixDependencies(lockPackages, checkPackages = radixPackages(lockPackages)) {
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
export function overrideMismatches(overrides, lockPackages, checkPackages = radixPackages(lockPackages)) {
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
