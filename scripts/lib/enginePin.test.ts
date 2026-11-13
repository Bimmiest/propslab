import { describe, it, expect } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { parseEnginePin } from './enginePin.mjs';

// The engine's pin, which vite.config.ts reads for the About dialog (#940).
const COMMIT = '34c37e00667a23a0fbe811a33a2bac06b6523a9c';

describe('parseEnginePin', () => {
  it('gives the repository and the full commit of a GitHub pin', () => {
    expect(parseEnginePin(`github:Bimmiest/propslab-engine#${COMMIT}`)).toEqual({
      repository: 'https://github.com/Bimmiest/propslab-engine',
      commit: COMMIT,
    });
  });

  it('reads the pin that package.json has now', () => {
    expect(() => parseEnginePin(pkg.dependencies['propslab-engine'])).not.toThrow();
  });

  it.each([
    ['a version range', '^0.4.0'],
    ['a tag', 'github:Bimmiest/propslab-engine#v0.4.0'],
    ['a short commit', 'github:Bimmiest/propslab-engine#34c37e0'],
    ['an upper-case commit', `github:Bimmiest/propslab-engine#${COMMIT.toUpperCase()}`],
    ['a git URL', `git+https://github.com/Bimmiest/propslab-engine.git#${COMMIT}`],
    ['no dependency', undefined],
  ])('stops the build for %s, and says the form that it needs', (_name, spec) => {
    expect(() => parseEnginePin(spec)).toThrow(/must be "github:<owner>\/<repo>#<the full 40-character commit>"/);
  });
});
