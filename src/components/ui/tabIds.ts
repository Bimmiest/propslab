// ---------------------------------------------------------------------------
// tabIds.ts
// The id scheme shared by <Tabs> and the tabpanel its caller renders.
//
// Ids are prefixed, not global to the document: two tablists that share a tab
// id — or one tablist rendered twice, as a layout switch can do — would
// otherwise produce duplicate ids, and aria-controls / aria-labelledby would
// resolve to whichever element came first. The caller takes a prefix from
// React's useId() and hands the same prefix to both sides. Kept out of
// Tabs.tsx so that file exports only a component
// (react-refresh/only-export-components).
// ---------------------------------------------------------------------------

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const tabPanelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;
