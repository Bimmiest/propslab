import type { ComponentProps } from 'react';
import { MonacoEditor as BaseMonacoEditor } from './MonacoEditor';
import { ensureSplunkMonaco } from './splunkMonacoSetup';

// The lazily-loaded half of LazyEditors.tsx: the only entry into monaco.
export { SplunkEditor } from './SplunkEditor';

export function MonacoEditor({ beforeMount, ...props }: ComponentProps<typeof BaseMonacoEditor>) {
  return (
    <BaseMonacoEditor
      {...props}
      beforeMount={() => {
        ensureSplunkMonaco();
        beforeMount?.();
      }}
    />
  );
}
