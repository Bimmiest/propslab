import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import './index.css'
import App from './App.tsx'

// Monaco (and its MonacoEnvironment) loads lazily; see LazyEditors.tsx.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={100}>
      <App />
    </RadixTooltip.Provider>
  </StrictMode>,
)
