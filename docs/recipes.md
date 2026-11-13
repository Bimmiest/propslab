---
type: how-to
---

# Recipes

Where each change goes, and the recipes for the common changes. [CONTRIBUTING.md](../CONTRIBUTING.md#where-a-change-goes) has the summary of the rules.

## Where a change goes

| What | Where |
|---|---|
| Simulation logic, directive metadata and directive support | [`propslab-engine`](https://github.com/Bimmiest/propslab-engine), then a release and a pin bump here. Its [recipes](https://github.com/Bimmiest/propslab-engine/blob/main/docs/recipes.md) give the steps for a simulated directive. |
| Editor behaviour (hover, completion, lint markers) | `src/monaco/` |
| UI | `src/components/` |

An export from `src/monaco` or a vendored file in `src/utils` or `src/workers` is public. propslab-sb and propslab-ent vendor these files, and their own code imports from them. Before you remove or rename an export, search those two repositories too. A search of this repository alone found `FALLBACK_TIME_SOURCES` unused, and its removal broke both (#570).

## Add a preview sub-tab
1. Create the component in `src/components/preview/tabs/`.
2. Add the ID to `PreviewSubTabId` in `src/store/useAppStore.ts`.
3. Add the entry to `PREVIEW_SUB_TABS` and render it in `PreviewSubTab.tsx`.
