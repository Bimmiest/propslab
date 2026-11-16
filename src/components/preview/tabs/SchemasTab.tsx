import { Suspense, useId } from 'react';
import { useAppStore, type SchemaView } from '../../../store/useAppStore';
import { retryableLazy } from '../../ui/retryableLazy';
import { CimModelsTab } from './CimModelsTab';

// The OCSF data is a chunk of its own, fetched only when the user selects
// OCSF, so the CIM view does not pay for it (#892).
const OcsfClassesTab = retryableLazy(() => import('./OcsfClassesTab').then((m) => ({ default: m.OcsfClassesTab })));

const VIEWS: { id: SchemaView; label: string }[] = [
  { id: 'cim', label: 'CIM' },
  { id: 'ocsf', label: 'OCSF' },
];

/** The Schemas tab: the extracted fields against the CIM or against OCSF. */
export function SchemasTab() {
  const view = useAppStore((s) => s.schemaView);
  const setView = useAppStore((s) => s.setSchemaView);
  const labelId = useId();

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 pt-3">
        <span id={labelId} className="text-xs text-[var(--color-text-muted)]">
          Schema
        </span>
        <div
          role="group"
          aria-labelledby={labelId}
          className="flex items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-px"
        >
          {VIEWS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              // A toggle group: aria-pressed carries the selection, which
              // styling alone does not.
              aria-pressed={view === id}
              className={[
                'px-2 py-0.5 text-xs rounded transition-colors cursor-pointer border-none',
                view === id
                  ? 'bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] font-medium shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] bg-transparent',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {view === 'cim' ? (
          <CimModelsTab />
        ) : (
          <Suspense fallback={null}>
            <OcsfClassesTab />
          </Suspense>
        )}
      </div>
    </div>
  );
}
