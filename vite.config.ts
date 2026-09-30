import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from './package.json' with { type: 'json' };
import swa from './public/staticwebapp.config.json' with { type: 'json' };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Surfaced in the status bar so a bug report can name the build it came from.
  // Read from package.json rather than duplicated, so `npm version` is the only
  // place a release number is written.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Serve the deployed headers from `vite preview` too, so the e2e suite runs
  // the workers under the same CSP they get in production (a worker ignores the
  // page's <meta> policy and takes its own from its response headers).
  preview: {
    headers: swa.globalHeaders,
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // Vite 8 bundles with Rolldown, which dropped the object form of
        // `manualChunks`; `codeSplitting.groups` replaces it. (`advancedChunks`
        // takes the same shape but is already deprecated as of 8.2.)
        //
        // A group only claims modules the graph already reached, unlike the
        // array form of `manualChunks`, which pulled the ids it named INTO the
        // graph. Nothing is lost
        // here — `MonacoEditor.tsx` imports each contribution directly, and the
        // pattern below covers the whole slim `esm/vs` tree they pull in.
        //
        // Matching on path also cannot drag anything in, so the `monaco-editor`
        // barrel stays out on its own merit: nothing imports it, which is what
        // keeps the ~80 basic-languages and the TS/JSON/CSS/HTML language
        // services (and their web workers) out of the bundle. See main.tsx.
        //
        // `includeDependenciesRecursively: false` on the Monaco group is
        // load-bearing (#467). By default a group also captures the
        // dependencies of the modules it matched; Vite's `__vitePreload`
        // helper, which the lazy imports need, was absorbed that way and
        // landed in the Monaco chunk — and the entry, which imports the helper,
        // then statically imported and modulepreloaded all 3.4 MB of Monaco.
        // scripts/check-entry-graph.mjs fails CI if that recurs.
        codeSplitting: {
          groups: [
            {
              name: 'monaco-editor',
              test: /monaco-editor[\\/]esm[\\/]vs[\\/]/,
              includeDependenciesRecursively: false,
            },
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom)[\\/]/ },
          ],
        },
      },
    },
  },
});
