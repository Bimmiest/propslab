import { describe, it, expect } from 'vitest';
import { CHECK_PACKAGES, overrideMismatches, radixDependencies } from '../../scripts/lib/radixOverrides.mjs';

// The comparison behind scripts/check-radix-overrides.mjs: an override that
// pins a @radix-ui package to a version its dependents do not ask for. Reading
// package.json and the lockfile is the script's own.
const lock = {
  'node_modules/@radix-ui/react-dialog': {
    dependencies: { '@radix-ui/react-portal': '1.1.0', '@radix-ui/react-slot': '1.2.0', react: '^19' },
  },
  'node_modules/@radix-ui/react-tooltip': {
    dependencies: { '@radix-ui/react-portal': '1.1.0', '@radix-ui/react-popper': '1.2.0' },
  },
  // Not among the checked packages: what it asks for is not read.
  'node_modules/@radix-ui/react-select': { dependencies: { '@radix-ui/react-portal': '0.9.0' } },
};

describe('radixDependencies', () => {
  it('collects the @radix-ui dependencies of the checked packages, with who asks for each', () => {
    expect(radixDependencies(lock)).toEqual({
      '@radix-ui/react-portal': [
        { package: '@radix-ui/react-dialog', version: '1.1.0' },
        { package: '@radix-ui/react-tooltip', version: '1.1.0' },
      ],
      '@radix-ui/react-slot': [{ package: '@radix-ui/react-dialog', version: '1.2.0' }],
      '@radix-ui/react-popper': [{ package: '@radix-ui/react-tooltip', version: '1.2.0' }],
    });
  });

  it('skips a dependency that is not @radix-ui, a package the lockfile lacks, and one with no dependencies', () => {
    expect(radixDependencies({ 'node_modules/@radix-ui/react-dialog': { dependencies: { react: '^19' } } })).toEqual(
      {},
    );
    expect(radixDependencies({ 'node_modules/@radix-ui/react-dialog': {} })).toEqual({});
    expect(radixDependencies({})).toEqual({});
  });

  it('checks the packages it is given', () => {
    expect(Object.keys(radixDependencies(lock, ['@radix-ui/react-select']))).toEqual(['@radix-ui/react-portal']);
  });

  it('defaults to the three packages the app uses', () => {
    expect(CHECK_PACKAGES).toEqual([
      '@radix-ui/react-dialog',
      '@radix-ui/react-context-menu',
      '@radix-ui/react-tooltip',
    ]);
  });
});

describe('overrideMismatches', () => {
  it('passes when every override is the version its dependents ask for', () => {
    expect(overrideMismatches({ '@radix-ui/react-portal': '1.1.0', '@radix-ui/react-slot': '1.2.0' }, lock)).toEqual(
      [],
    );
  });

  it('names each dependent that asks for something else', () => {
    expect(overrideMismatches({ '@radix-ui/react-portal': '1.0.9' }, lock)).toEqual([
      {
        package: '@radix-ui/react-portal',
        override: '1.0.9',
        dependency: '1.1.0',
        dependentPackage: '@radix-ui/react-dialog',
      },
      {
        package: '@radix-ui/react-portal',
        override: '1.0.9',
        dependency: '1.1.0',
        dependentPackage: '@radix-ui/react-tooltip',
      },
    ]);
  });

  it('names only the dependent that disagrees', () => {
    const skewed = {
      ...lock,
      'node_modules/@radix-ui/react-tooltip': { dependencies: { '@radix-ui/react-portal': '1.2.0' } },
    };
    expect(overrideMismatches({ '@radix-ui/react-portal': '1.1.0' }, skewed)).toEqual([
      {
        package: '@radix-ui/react-portal',
        override: '1.1.0',
        dependency: '1.2.0',
        dependentPackage: '@radix-ui/react-tooltip',
      },
    ]);
  });

  it('ignores an override of a package no checked package depends on', () => {
    expect(overrideMismatches({ '@radix-ui/react-unused': '9.9.9', lodash: '4.0.0' }, lock)).toEqual([]);
  });

  it('has nothing to say without overrides', () => {
    expect(overrideMismatches({}, lock)).toEqual([]);
  });
});
