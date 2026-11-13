// The engine's pin in package.json, in the form vite.config.ts gives to the
// About dialog and the build label (#940). The app shows the commit that it
// installs, so a pin that names no commit stops the build: a version range or
// a branch would show a commit that the bundle does not contain.

const PIN = /^github:([\w.-]+)\/([\w.-]+)#([0-9a-f]{40})$/;

/**
 * The repository and the full commit of a `propslab-engine` dependency spec.
 * Throws when the spec is not `github:<owner>/<repo>#<40-hex commit>`.
 * @param {string | undefined} spec
 * @returns {{ repository: string, commit: string }}
 */
export function parseEnginePin(spec) {
  const match = PIN.exec(spec ?? '');
  if (!match) {
    throw new Error(
      `The propslab-engine dependency in package.json is "${spec ?? ''}". The About dialog shows the engine's commit, ` +
        'so the dependency must be "github:<owner>/<repo>#<the full 40-character commit>" (docs/dependencies.md).',
    );
  }
  const [, owner, repo, commit] = match;
  return { repository: `https://github.com/${owner}/${repo}`, commit };
}
