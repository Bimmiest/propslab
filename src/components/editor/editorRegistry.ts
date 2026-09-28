import type { editor } from 'monaco-editor';

const _editors = new Map<string, editor.IStandaloneCodeEditor>();

export function registerEditor(file: string, instance: editor.IStandaloneCodeEditor): void {
  _editors.set(file, instance);
}

export function getEditor(file: string): editor.IStandaloneCodeEditor | undefined {
  return _editors.get(file);
}

/**
 * Remove an editor from the registry on unmount so consumers (EditorValidationList)
 * don't later call .focus()/.setPosition() on a disposed instance. Only deletes
 * when the stored instance still matches — guards against a remount
 * (collapse/mobile switch) where the new editor registers before the old one's
 * cleanup runs, which would otherwise evict the live instance.
 */
export function unregisterEditor(file: string, instance: editor.IStandaloneCodeEditor): void {
  if (_editors.get(file) === instance) _editors.delete(file);
}
