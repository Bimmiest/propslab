import { useMemo, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { ValidationDiagnostic, DiagnosticTarget } from '../../engine/types';
import { Icon } from '../ui/Icon';
import { revealInEditor } from './revealInEditor';

interface EditorValidationListProps {
  file: DiagnosticTarget;
}

export function EditorValidationList({ file }: EditorValidationListProps) {
  const diagnostics = useAppStore((s) => s.validationDiagnostics);
  const [expanded, setExpanded] = useState(true);

  const filtered = useMemo(() => diagnostics.filter((d) => d.file === file), [diagnostics, file]);

  const errorCount = filtered.filter((d) => d.level === 'error').length;
  const warningCount = filtered.filter((d) => d.level === 'warning').length;
  const infoCount = filtered.filter((d) => d.level === 'info').length;

  if (filtered.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <StatusIcon level="success" />
        <span className="text-xs text-[var(--color-success)]">No issues</span>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-3 py-1 hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {errorCount > 0 && (
            <span className="text-xs font-medium text-[var(--color-error)]">
              {errorCount} error{errorCount !== 1 ? 's' : ''}
            </span>
          )}
          {warningCount > 0 && (
            <span className="text-xs font-medium text-[var(--color-warning)]">
              {warningCount} warning{warningCount !== 1 ? 's' : ''}
            </span>
          )}
          {infoCount > 0 && <span className="text-xs font-medium text-[var(--color-info)]">{infoCount} info</span>}
        </div>
        <Icon
          name="chevron-down"
          className={`w-3.5 h-3.5 text-[var(--color-text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className="max-h-32 overflow-auto divide-y divide-[var(--color-border)]">
          {filtered.map((diag, idx) => (
            <DiagnosticRow
              key={idx}
              diagnostic={diag}
              onNavigate={
                diag.line !== undefined
                  ? () => {
                      if (diag.line !== undefined) revealInEditor(file, diag.line);
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DiagnosticRow({ diagnostic, onNavigate }: { diagnostic: ValidationDiagnostic; onNavigate?: () => void }) {
  const content = (
    <>
      <div className="flex-shrink-0">
        <StatusIcon level={diagnostic.level} />
      </div>
      <div className="flex-1 min-w-0">
        <span
          className="text-xs text-[var(--color-text-primary)]"
          style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
        >
          {diagnostic.message}
        </span>
        {diagnostic.line !== undefined && (
          <span className="ml-2 text-xs text-[var(--color-text-muted)]">line {diagnostic.line}</span>
        )}
        {diagnostic.suggestion && (
          <div className="text-xs text-[var(--color-success)]" style={{ overflowWrap: 'anywhere' }}>
            {diagnostic.suggestion}
          </div>
        )}
      </div>
    </>
  );

  const base = 'flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-bg-tertiary)] transition-colors';

  // When the row jumps to a line, render a real <button> so it's keyboard
  // focusable and activates on Enter/Space (a clickable <div> was mouse-only).
  if (onNavigate) {
    return (
      <button type="button" onClick={onNavigate} className={`${base} w-full text-left cursor-pointer`}>
        {content}
      </button>
    );
  }
  return <div className={base}>{content}</div>;
}

function StatusIcon({ level }: { level: 'error' | 'warning' | 'info' | 'success' }) {
  const colorClass =
    level === 'error'
      ? 'text-[var(--color-error)]'
      : level === 'warning'
        ? 'text-[var(--color-warning)]'
        : level === 'success'
          ? 'text-[var(--color-success)]'
          : 'text-[var(--color-info)]';

  const iconName =
    level === 'success'
      ? 'check'
      : level === 'error'
        ? 'error-circle'
        : level === 'warning'
          ? 'warning'
          : 'info-circle';

  return <Icon name={iconName} className={`w-3.5 h-3.5 ${colorClass}`} />;
}
