/**
 * Monaco models and view states that outlive the editor showing them (#453).
 *
 * Collapsing a panel remounts SimulatorView's vertical group, and the mobile
 * layout mounts one editor at a time, so an editor is disposed and rebuilt in
 * ordinary use. Undo history lives in the model and cursor, selection and
 * scroll in the editor's view state; keeping both here, per file, lets the
 * next editor for that file pick up where the last one left off. In memory
 * only: nothing here survives the tab.
 *
 * Kept free of monaco imports so it stays out of the entry chunk and can be
 * tested without an editor.
 */

interface DisposableModel {
  isDisposed(): boolean;
}

const _models = new Map<string, DisposableModel>();
const _viewStates = new Map<string, unknown>();

/** The live model kept for `key`, or a new one from `create`, kept from now on. */
export function acquireModel<M extends DisposableModel>(key: string, create: () => M): M {
  const existing = _models.get(key) as M | undefined;
  if (existing && !existing.isDisposed()) return existing;
  const model = create();
  _models.set(key, model);
  return model;
}

/** Store an unmounting editor's view state for the next editor on `key`. */
export function saveViewState(key: string, state: unknown): void {
  if (state == null) _viewStates.delete(key);
  else _viewStates.set(key, state);
}

/** The view state saved for `key`, removed so it is restored at most once. */
export function takeViewState(key: string): unknown {
  const state = _viewStates.get(key);
  _viewStates.delete(key);
  return state;
}

/** Test hook: forget every kept model and view state. */
export function resetModelRegistry(): void {
  _models.clear();
  _viewStates.clear();
}
