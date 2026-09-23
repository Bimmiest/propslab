// ---------------------------------------------------------------------------
// tabIds.ts
// The id scheme shared by <Tabs> and the tabpanel its caller renders.
//
// Ids used to be the bare `tab-${id}` / `tabpanel-${id}`, global to the
// document. Two tablists that ever shared a tab id — or one tablist rendered
// twice, as a layout switch can do — produced duplicate ids, and aria-controls /
// aria-labelledby then resolved to whichever element came first (#300). The
// caller now takes a prefix from React's useId() and hands the same prefix to
// both sides. Kept out of Tabs.tsx so that file exports only a component
// (react-refresh/only-export-components).
// ---------------------------------------------------------------------------

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const tabPanelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;
