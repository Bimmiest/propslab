// Vitest global setup (#572). The tests that spawn the server or a worker run
// dist/, which `npm test` builds first (`pretest`). A bare `npx vitest` after
// an edit ran the old bundle, and its tests passed or failed for code that
// was no longer there. This stops the run instead, and says what to do.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

/** The newest modification time of a .ts file under `dir`, tests aside. */
function newestSource(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') newest = Math.max(newest, newestSource(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

const builtAt = (file: string) => {
  try {
    return statSync(path.join(root, 'dist', file)).mtimeMs;
  } catch {
    return 0;
  }
};

export default function setup(): void {
  const built = Math.min(builtAt('index.js'), builtAt('simulateWorker.js'));
  // The bundle compiles in the engine and the utilities it imports from the app.
  const sources = Math.max(
    newestSource(path.join(root, 'src')),
    newestSource(path.join(root, '../../src/engine')),
    newestSource(path.join(root, '../../src/utils')),
  );
  if (built < sources) {
    throw new Error(
      'dist/ is missing or older than the sources it bundles, so the tests would run old code. ' +
        'Run `npm run build` first, or run the tests with `npm test`, which builds.',
    );
  }
}
