// The dependency pins that follow another package without a manual step
// (#776). The files are imported as text because the app's tsconfig has no
// Node types. Monaco's package.json is imported by path: its `exports` hide it
// from the package name.
import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';
import monacoPackage from '../../node_modules/monaco-editor/package.json?raw';
import lockfile from '../../package-lock.json?raw';

describe('marked', () => {
  // The hover tests render Markdown with `marked` the way the editor does, and
  // the editor uses the copy that Monaco declares. A different version would
  // make the tests check output that the editor never produces.
  it('is the version that monaco-editor declares', () => {
    const monaco = JSON.parse(monacoPackage) as {
      version: string;
      dependencies: Record<string, string>;
    };
    const declared = monaco.dependencies['marked'];
    expect(
      pkg.devDependencies.marked,
      `monaco-editor ${monaco.version} declares marked ${declared}. Set "marked" in package.json devDependencies to "${declared}" and run npm install.`,
    ).toBe(declared);
  });
});

describe('@radix-ui', () => {
  // The Radix primitives used to be pinned in `overrides` so that cmdk, which
  // asks for older caret ranges, did not get a second copy of each (#147).
  // The ranges now resolve to the same versions, and the pins are gone. A
  // nested copy means that they do not any more.
  it('has one copy of each package in the lockfile', () => {
    const lock = JSON.parse(lockfile) as { packages: Record<string, unknown> };
    const nested = Object.keys(lock.packages).filter((key) => /node_modules\/.+\/node_modules\/@radix-ui\//.test(key));
    expect(
      nested,
      'A Radix package has a nested copy, and the bundle ships both. Run npm dedupe. If that does not remove it, add the version that react-dialog resolves to `overrides` in package.json, and list the override in docs/dependencies.md.',
    ).toEqual([]);
  });
});
