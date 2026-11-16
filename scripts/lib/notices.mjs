// The third-party notices that the site serves (#892). The bundle carries
// data and code under licences that ask for their notices to go with them:
// the OCSF schema (Apache-2.0) and PCRE2 (BSD-3-Clause). A visitor gets the
// bundle, not the repository, so the build copies each notice from its one
// source into the output, and the dev server serves the same file.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The files that the site serves, by their published name. `from` is the
 * file that the build copies, so the served text cannot differ from it.
 * @param {string} root The directory of the app's package.json.
 * @returns {{ fileName: string, from: string }[]}
 */
export function noticeFiles(root) {
  const require = createRequire(join(root, 'package.json'));
  const engine = dirname(require.resolve('propslab-engine/package.json'));
  // The regex engine's exports name no package.json, so its root comes from the module it exports.
  const pcre2 = dirname(require.resolve('pcre2-wasm-utf16/pcre2.wasm'));
  return [
    { fileName: 'NOTICE.txt', from: join(root, 'NOTICE') },
    { fileName: 'LICENSE-OCSF.txt', from: join(engine, 'LICENSE-OCSF') },
    { fileName: 'LICENCE-PCRE2.txt', from: join(pcre2, 'LICENCE-PCRE2.md') },
  ];
}

/**
 * A Vite plugin: emits each notice into the build, and serves it from the dev
 * server, as plain text.
 * @param {{ fileName: string, from: string }[]} files
 * @returns {import('vite').Plugin}
 */
export function noticesPlugin(files) {
  return {
    name: 'propslab:notices',
    generateBundle() {
      for (const { fileName, from } of files) this.emitFile({ type: 'asset', fileName, source: readFileSync(from) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.find((f) => req.url === `/${f.fileName}`);
        if (!file) return next();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(readFileSync(file.from));
      });
    },
  };
}
