import { describe, it, expect } from 'vitest';
import {
  obsoleteScopedOverrides,
  overrideMismatches,
  radixDependencies,
  radixPackages,
} from '../../scripts/lib/radixOverrides.mjs';

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
  // Nested under another package, so not a top-level Radix package: not read.
  'node_modules/cmdk/node_modules/@radix-ui/react-select': { dependencies: { '@radix-ui/react-portal': '0.9.0' } },
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
    expect(Object.keys(radixDependencies(lock, ['@radix-ui/react-tooltip']))).toEqual([
      '@radix-ui/react-portal',
      '@radix-ui/react-popper',
    ]);
  });
});

describe('radixPackages', () => {
  it('lists every top-level @radix-ui package, and nothing nested or unscoped (#622)', () => {
    expect(radixPackages({ ...lock, 'node_modules/react': {}, '': {} })).toEqual([
      '@radix-ui/react-dialog',
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

describe('overrideMismatches — overrides only other Radix packages ask for (#622)', () => {
  it('compares an override against a transitive Radix dependent', () => {
    const transitive = {
      'node_modules/@radix-ui/react-dialog': { dependencies: { '@radix-ui/react-dismissable-layer': '1.2.0' } },
      'node_modules/@radix-ui/react-dismissable-layer': {
        dependencies: { '@radix-ui/react-use-callback-ref': '1.1.6' },
      },
    };
    expect(
      overrideMismatches(
        { '@radix-ui/react-dismissable-layer': '1.2.0', '@radix-ui/react-use-callback-ref': '1.1.5' },
        transitive,
      ),
    ).toEqual([
      {
        package: '@radix-ui/react-use-callback-ref',
        override: '1.1.5',
        dependency: '1.1.6',
        dependentPackage: '@radix-ui/react-dismissable-layer',
      },
    ]);
  });
});

describe('obsoleteScopedOverrides (#575)', () => {
  const overrides = { '@radix-ui/react-portal': '1.1.0', 'monaco-editor': { dompurify: '^3.4.17' } };

  it('keeps an override while the parent pins something older', () => {
    const pinned = { 'node_modules/monaco-editor': { dependencies: { dompurify: '3.4.15' } } };
    expect(obsoleteScopedOverrides(overrides, pinned)).toEqual([]);
  });

  it('names an override once the parent asks for the fixed version or later', () => {
    const obsolete = [{ parent: 'monaco-editor', package: 'dompurify', override: '^3.4.17' }];
    for (const asked of ['3.4.17', '^3.4.20', '3.5.0'])
      expect(
        obsoleteScopedOverrides(overrides, { 'node_modules/monaco-editor': { dependencies: { dompurify: asked } } }),
      ).toEqual(obsolete);
  });

  it('names an override whose parent is gone or no longer depends on the package', () => {
    const obsolete = [{ parent: 'monaco-editor', package: 'dompurify', override: '^3.4.17' }];
    expect(obsoleteScopedOverrides(overrides, {})).toEqual(obsolete);
    expect(obsoleteScopedOverrides(overrides, { 'node_modules/monaco-editor': { dependencies: {} } })).toEqual(
      obsolete,
    );
  });

  it('keeps an override while any copy of the parent, nested ones included, still pins something older', () => {
    const twoCopies = {
      'node_modules/monaco-editor': { dependencies: { dompurify: '3.5.0' } },
      'node_modules/x/node_modules/monaco-editor': { dependencies: { dompurify: '3.4.15' } },
    };
    expect(obsoleteScopedOverrides(overrides, twoCopies)).toEqual([]);
  });

  it('keeps an override it cannot read a version from', () => {
    const unreadable = { 'node_modules/monaco-editor': { dependencies: { dompurify: '*' } } };
    expect(obsoleteScopedOverrides(overrides, unreadable)).toEqual([]);
  });
});
