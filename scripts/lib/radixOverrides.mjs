// The comparisons behind scripts/check-radix-overrides.mjs, apart from reading
// package.json and the lockfile: which @radix-ui packages the checked packages
// depend on, where an override pins one to a version they do not ask for, and
// which scoped overrides (the non-Radix ones) their parent no longer needs.

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

/**
 * Each scoped override (`"parent": { "dep": "^x.y.z" }`) that its parent no
 * longer needs: no copy of the parent in the lockfile still asks for a `dep`
 * older than `x.y.z`. These overrides lift a dependency that the parent pins
 * past an advisory (CONTRIBUTING, "The Radix overrides"). One left behind after
 * the parent caught up would hold the dependency back without a reason.
 * A version that cannot be read (`*`, a git URL) counts as still needing it.
 * @param {Record<string, string | Record<string, string>>} overrides package.json's `overrides`
 * @param {Record<string, { dependencies?: Record<string, string> }>} lockPackages
 * @returns {{ parent: string, package: string, override: string }[]}
 */
export function obsoleteScopedOverrides(overrides, lockPackages) {
  const issues = [];
  for (const [parent, scoped] of Object.entries(overrides)) {
    if (typeof scoped !== 'object') continue;
    const copies = Object.entries(lockPackages)
      .filter(([key]) => key === `node_modules/${parent}` || key.endsWith(`/node_modules/${parent}`))
      .map(([, entry]) => entry);
    for (const [pkg, override] of Object.entries(scoped)) {
      const wanted = lowestVersion(override);
      const needed = copies.some((copy) => {
        const asked = copy.dependencies?.[pkg];
        if (asked === undefined) return false;
        const floor = lowestVersion(asked);
        return !floor || !wanted || compareVersions(floor, wanted) < 0;
      });
      if (!needed) issues.push({ parent, package: pkg, override });
    }
  }
  return issues;
}

/** @param {string} spec @returns {number[] | null} the first x.y.z in a version or range */
function lowestVersion(spec) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(spec);
  return match ? match.slice(1).map(Number) : null;
}

/** @param {number[]} a @param {number[]} b */
function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
