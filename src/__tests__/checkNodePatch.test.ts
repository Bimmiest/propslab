import { describe, it, expect } from 'vitest';

/**
 * The comparison behind the scheduled Node-patch reminder (#518). The fetch and
 * the exit code are the script's own and need the network; the part that can be
 * wrong is reading versions and choosing the newest one on a line.
 */

type Version = [number, number, number];
interface Script {
  parseVersion: (text: string) => Version | null;
  compareVersions: (a: Version, b: Version) => number;
  latestOfMajor: (index: unknown[], major: number) => Version | null;
}

// Through import.meta.glob: the app's tsconfig has no Node types (see docs.test.ts).
const scripts = import.meta.glob<Script>('/scripts/check-node-patch.mjs', { eager: true });
const { parseVersion, compareVersions, latestOfMajor } = scripts['/scripts/check-node-patch.mjs']!;

describe('parseVersion', () => {
  it('reads .nvmrc and index.json spellings', () => {
    expect(parseVersion('24.18.1\n')).toEqual([24, 18, 1]);
    expect(parseVersion('v24.18.1')).toEqual([24, 18, 1]);
  });

  it('rejects anything that is not an exact x.y.z, so a loose .nvmrc is an error', () => {
    for (const text of ['24', '24.18', 'lts/*', 'v24.18.1-rc.1', '']) expect(parseVersion(text)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions([24, 9, 0], [24, 18, 1])).toBeLessThan(0);
    expect(compareVersions([24, 18, 10], [24, 18, 9])).toBeGreaterThan(0);
    expect(compareVersions([24, 18, 1], [24, 18, 1])).toBe(0);
  });
});

describe('latestOfMajor', () => {
  // nodejs.org/dist/index.json is newest-first, but nothing here relies on it.
  const index = [
    { version: 'v26.10.0' },
    { version: 'v24.9.0' },
    { version: 'v24.21.0' },
    { version: 'v24.18.1' },
    { version: 'v22.30.0' },
    { version: 'not-a-version' },
    {},
    null,
  ];

  it('picks the newest release on the requested line only', () => {
    expect(latestOfMajor(index, 24)).toEqual([24, 21, 0]);
    expect(latestOfMajor(index, 22)).toEqual([22, 30, 0]);
  });

  it('says so when the line is not listed', () => {
    expect(latestOfMajor(index, 20)).toBeNull();
  });
});
