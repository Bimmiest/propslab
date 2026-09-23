# Architecture notes

Contributor-facing internals. The user-facing architecture — pipeline order, stanza precedence, layout — is in the [README](../README.md).

## State management

Single Zustand store (`src/store/useAppStore.ts`). The store is flat — components subscribe to individual slices rather than reading the whole store.

```
rawData / metadata / propsConf / transformsConf     User inputs (ephemeral)
processingResult / validationDiagnostics            Pipeline output
isProcessing / lastProcessingMs                     StatusBar telemetry
theme / activeOutputTab / collapsedPanels / ...     UI state
activeView / dictionarySelection                    Rail view + dictionary deep link
settings / pipelineDirty / manualRunTick            Simulator options and the manual-apply run trigger
```

localStorage is limited to UI layout state (split-pane sizes, seen-intro flag, theme), read inside try/catch with typed fallbacks. Raw logs and configuration are not persisted — a refresh clears them.

Monaco editor instances live in a module-level `Map` in `editorRegistry.ts`, not in the Zustand store.

## Monaco bundling

Monaco's widgets (hover, suggest, folding, find, multi-cursor) are *contributions*, imported separately from the API surface in `MonacoEditor.tsx` via `editor.all`. `editor.api` alone registers providers that nothing ever renders. `vite.config.ts` groups the slim `esm/vs` tree both entries pull in via `codeSplitting` (Rolldown's replacement for `manualChunks` — it claims modules the graph already reached rather than naming ids to pull in, so `editor.all` is held there by its own import in `MonacoEditor.tsx`). A bad split type-checks and builds, then fails to mount an editor — which is one of the things the e2e suite exists to catch (see the README's Tests section).

## Accessibility

- Skip-to-content link (visible on focus).
- Semantic HTML (`<main>`, `<header>`, proper heading hierarchy).
- WAI-ARIA tablist: `role="tablist"` / `role="tab"` / `role="tabpanel"`, `aria-selected`, `aria-controls`, `aria-labelledby`.
- Arrow keys navigate tabs; Home/End jump to first/last. The activity rail is vertical and declares `aria-orientation`.
- The rail's buttons carry `aria-label`, not just a tooltip: they have no visible text, and a Radix tooltip contributes `aria-describedby`, which supplements an accessible name rather than supplying one.
- The dictionary list is a `role="listbox"` driven by `aria-activedescendant`, so one Tab stop covers 80-odd rows.
- Inputs have an accessible name: an associated `<label>` via `htmlFor`/`id` (ids from `useId`), or `aria-label` where there is no visible label.
- A global `:focus-visible` outline in `index.css` is the floor for every focusable element; components that draw their own `focus-visible:ring-*` take precedence over it. Do not add `outline-none` without a replacement ring.
- Clickable spans and divs that cannot be `<button>`s go through `components/ui/pressable.ts`, which adds the tab stop, `role="button"` and Enter/Space. The highlighted spans inside raw event text are the deliberate exception: one tab stop per value would bury the page, and the field sidebar offers the same pin action.
- Raw-text selection (`SelectableRaw`) has a keyboard path: arrows select tokens, Shift extends, Shift+F10 or the Menu key opens the row's context menu.
- `eslint-plugin-jsx-a11y` is not wired into lint: its peer range ends at eslint 9. Tracked in #302.
- Panel-level `ErrorBoundary` with "Try Again" recovery.

### Overlays

Every overlay — command palette, settings, scaffold modal, pipeline reference,
directive dialogs — goes through `components/ui/Overlay.tsx`, which wraps
`@radix-ui/react-dialog`. That supplies the Escape layer stack (only the topmost
overlay closes), the focus trap, background inertness, scroll lock, and focus
return to the trigger.

Two props exist for one consumer each, and both encode a bug found while
adopting Radix:

- **`forceMount`** keeps a sliding panel mounted while closed. A closed
  force-mounted overlay is marked `inert` and `aria-hidden` by `Overlay` itself
  — otherwise it remains a `dialog` in the accessibility tree with focusable
  buttons parked off-screen, and role-based queries find it instead of whatever
  is actually open.
- **Modality is scoped to `open`** (`modal={open}`). Left permanently modal, a
  force-mounted overlay keeps the *rest of the app* `aria-hidden` while it sits
  closed, which makes every element in the app unreachable to assistive tech.

Neither shows up in a unit test of an overlay on its own; the e2e suite caught
both.
