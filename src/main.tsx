import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import './index.css'
import App from './App.tsx'
import { loadRegexEngine } from './utils/regexEngineLoader'

// Monaco (and its MonacoEnvironment) loads lazily; see LazyEditors.tsx.
const root = createRoot(document.getElementById('root')!)

// Every user pattern runs on PCRE2 in WebAssembly, and the editor validates
// patterns as soon as it mounts, so the engine is up before the first render.
// Workers built afterwards are handed this compiled module (regexEngineLoader).
// A promise chain rather than a top-level await: with one in the entry module,
// the bundler scatters the entry's own modules into extra startup chunks.
loadRegexEngine().then(
  () =>
    root.render(
      <StrictMode>
        <RadixTooltip.Provider delayDuration={400} skipDelayDuration={100}>
          <App />
        </RadixTooltip.Provider>
      </StrictMode>,
    ),
  (e: unknown) =>
    root.render(
      <div role="alert" style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        Propslab could not start its regex engine: {e instanceof Error ? e.message : String(e)}. Reload the
        page to try again.
      </div>,
    ),
)
