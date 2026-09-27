import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Surfaced in the status bar so a bug report can name the build it came from.
  // Read from package.json rather than duplicated, so `npm version` is the only
  // place a release number is written.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // Vite 8 bundles with Rolldown, which dropped the object form of
        // `manualChunks`; `codeSplitting.groups` replaces it. (`advancedChunks`
        // takes the same shape but is already deprecated as of 8.2.)
        //
        // The two are not interchangeable: the old array form pulled the module
        // ids it named INTO the graph, which is why editor.all had to be listed
        // beside editor.api or every contribution scattered into the app chunk.
        // A group only claims modules the graph already reached. Nothing is lost
        // here — `MonacoEditor.tsx` imports each contribution directly, and the
        // pattern below covers the whole slim `esm/vs` tree they pull in.
        //
        // Matching on path also cannot drag anything in, so the `monaco-editor`
        // barrel stays out on its own merit: nothing imports it, which is what
        // keeps the ~80 basic-languages and the TS/JSON/CSS/HTML language
        // services (and their web workers) out of the bundle. See TOOL-2 /
        // main.tsx.
        codeSplitting: {
          groups: [
            { name: 'monaco-editor', test: /monaco-editor[\\/]esm[\\/]vs[\\/]/ },
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom)[\\/]/ },
          ],
        },
      },
    },
  },
})
