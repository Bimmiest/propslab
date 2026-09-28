import { lazy, Suspense, type ComponentProps } from 'react';
import type { MonacoEditor as MonacoEditorComponent } from './MonacoEditor';
import type { SplunkEditor as SplunkEditorComponent } from './SplunkEditor';

/**
 * Monaco, behind a dynamic import so first paint does not wait for it.
 *
 * Everything that imports monaco at runtime (MonacoEditor, SplunkEditor,
 * splunkMonacoSetup and the providers it registers) is reached only through
 * `loadEditors`, so the ~3 MB editor chunk is fetched in parallel with the
 * shell rendering rather than ahead of it. Import this file, never those
 * modules directly, from anything on the startup path.
 */
const loadEditors = () => import('./editorRuntime');

const LazyMonaco = lazy(() => loadEditors().then((m) => ({ default: m.MonacoEditor })));
const LazySplunk = lazy(() => loadEditors().then((m) => ({ default: m.SplunkEditor })));

/** Holds the editor's box while its chunk loads, so the layout does not jump. */
function EditorPlaceholder({ label }: { label: string }) {
  return (
    <div className="w-full h-full bg-[var(--color-bg-primary)]" role="status" aria-label={`Loading ${label} editor`} />
  );
}

/**
 * A plain Monaco editor. The splunk themes are registered before mount
 * whether or not the caller asks, since every editor here paints with them.
 */
export function MonacoEditor(props: ComponentProps<typeof MonacoEditorComponent>) {
  return (
    <Suspense fallback={<EditorPlaceholder label={props.options?.ariaLabel ?? 'text'} />}>
      <LazyMonaco {...props} />
    </Suspense>
  );
}

export function SplunkEditor(props: ComponentProps<typeof SplunkEditorComponent>) {
  return (
    <Suspense fallback={<EditorPlaceholder label={props.fileType ?? 'props.conf'} />}>
      <LazySplunk {...props} />
    </Suspense>
  );
}
