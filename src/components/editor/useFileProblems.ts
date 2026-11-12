import { useMemo } from 'react';
import type { DiagnosticLevel, DiagnosticTarget } from 'propslab-engine';
import { useAppStore } from '../../store/useAppStore';
import { useDebounce } from '../../hooks/useDebounce';
import { countByLevel } from '../../utils/diagnosticCounts';
import { fileProblems, lintConf, type FileProblems } from '../../monaco/editorProblems';

/** The pause after an edit before the linter reads the text, in the editor and here alike. */
export const LINT_DELAY_MS = 500;

const NO_LINT: [] = [];

/**
 * The problems of one file, as its panel lists them and its editor marks them
 * (`fileProblems`). The linter reads the store's text once it has settled,
 * which is the text the editor lints at the same moment.
 */
export function useFileProblems(file: DiagnosticTarget): FileProblems {
  const text = useAppStore((s) =>
    file === 'props.conf' ? s.propsConf : file === 'transforms.conf' ? s.transformsConf : '',
  );
  const settled = useDebounce(text, LINT_DELAY_MS);
  const run = useAppStore((s) => s.validationDiagnostics);
  return useMemo(
    () => fileProblems(file, file === 'raw' ? NO_LINT : lintConf(settled, file), run),
    [file, settled, run],
  );
}

/** The problems of all three inputs, counted by level, for the status bar and its announcement. */
export function useProblemCounts(): Record<DiagnosticLevel, number> {
  const raw = useFileProblems('raw').problems;
  const props = useFileProblems('props.conf').problems;
  const transforms = useFileProblems('transforms.conf').problems;
  return useMemo(() => countByLevel([...raw, ...props, ...transforms]), [raw, props, transforms]);
}
