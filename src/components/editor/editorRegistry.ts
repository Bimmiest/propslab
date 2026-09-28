import type { editor } from 'monaco-editor';

const _editors = new Map<string, editor.IStandaloneCodeEditor>();
const _listeners = new Map<string, Set<(instance: editor.IStandaloneCodeEditor) => void>>();

export function registerEditor(file: string, instance: editor.IStandaloneCodeEditor): void {
  _editors.set(file, instance);
  for (const listener of [...(_listeners.get(file) ?? [])]) listener(instance);
}

export function getEditor(file: string): editor.IStandaloneCodeEditor | undefined {
  return _editors.get(file);
}

/**
 * Call `listener` each time an editor registers under `file`, for a caller that
 * has just asked for the editor to be mounted. Returns the unsubscribe.
 */
export function onEditorRegistered(
  file: string,
  listener: (instance: editor.IStandaloneCodeEditor) => void,
): () => void {
  let set = _listeners.get(file);
  if (!set) _listeners.set(file, (set = new Set()));
  set.add(listener);
  return () => { set.delete(listener); };
}

/**
 * Remove an editor from the registry on unmount so consumers (revealInEditor)
 * don't later call .focus()/.setPosition() on a disposed instance. Only deletes
 * when the stored instance still matches — guards against a remount
 * (collapse/mobile switch) where the new editor registers before the old one's
 * cleanup runs, which would otherwise evict the live instance.
 */
export function unregisterEditor(file: string, instance: editor.IStandaloneCodeEditor): void {
  if (_editors.get(file) === instance) _editors.delete(file);
}
