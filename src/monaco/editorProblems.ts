// ---------------------------------------------------------------------------
// editorProblems.ts
// The one list of problems for each editor: the markers in the editor, the
// panel under it and the counts in the status bar all come from it (#899).
//
// Two validators report on a conf file. The linter (computeDiagnostics) reads
// the text as it is typed and places a marker on the exact columns. The
// pipeline run reports what only a run can know, such as a LOOKUP it does not
// simulate. Each also reports some problems that the other reports, in other
// words: a malformed line, or a pattern that does not compile. So a run
// diagnostic is dropped when the linter marks the same line at the same level
// or above, and the linter's marker stands for both.
// ---------------------------------------------------------------------------

import type { DiagnosticLevel, DiagnosticTarget, ValidationDiagnostic } from 'propslab-engine';
import { computeDiagnostics, type DiagnosticMarker, type LineSource } from './splunkConfDiagnostics';

type ConfFile = 'props.conf' | 'transforms.conf';

/** `text` as lines, split where Monaco's model splits them. */
export function textLines(text: string): LineSource {
  const lines = text.split(/\r\n|\r|\n/);
  return { getLineCount: () => lines.length, getLineContent: (n) => lines[n - 1] ?? '' };
}

const lastLint = new Map<ConfFile, { text: string; markers: readonly DiagnosticMarker[] }>();

/**
 * The linter's markers for `text`. The editor, its panel and the status bar
 * each ask for the same text, so the last answer for each file is kept.
 */
export function lintConf(text: string, file: ConfFile): readonly DiagnosticMarker[] {
  const last = lastLint.get(file);
  if (last?.text === text) return last.markers;
  const markers = computeDiagnostics(textLines(text), file);
  lastLint.set(file, { text, markers });
  return markers;
}

const LEVEL: Record<DiagnosticMarker['severity'], DiagnosticLevel> = { 8: 'error', 4: 'warning', 2: 'info', 1: 'info' };
const SEVERITY: Record<DiagnosticLevel, DiagnosticMarker['severity']> = { error: 8, warning: 4, info: 2 };

export interface FileProblems {
  /** The rows of the panel: the problems without a line first, then by line. */
  problems: ValidationDiagnostic[];
  /** The same problems, less those without a line, as the editor's markers. */
  markers: DiagnosticMarker[];
}

/**
 * The problems of `file`: the linter's markers, and the run's diagnostics for
 * the file that the linter does not already report on their line.
 */
export function fileProblems(
  file: DiagnosticTarget,
  lint: readonly DiagnosticMarker[],
  run: readonly ValidationDiagnostic[],
): FileProblems {
  const lintedAt = new Map<number, number>();
  for (const m of lint) lintedAt.set(m.startLineNumber, Math.max(lintedAt.get(m.startLineNumber) ?? 0, m.severity));

  const kept = run.filter(
    (d) => d.file === file && (d.line === undefined || (lintedAt.get(d.line) ?? 0) < SEVERITY[d.level]),
  );
  const fromLint = lint.map((m): ValidationDiagnostic => ({
    level: LEVEL[m.severity],
    message: m.message,
    file,
    line: m.startLineNumber,
    column: m.startColumn,
  }));
  const problems = [...fromLint, ...kept].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  const markers = [...lint];
  for (const d of kept) {
    if (d.line === undefined) continue;
    // An empty range: Monaco widens it to the word at the column, so a
    // diagnostic with no column marks the first word of its line.
    const column = d.column ?? 1;
    markers.push({
      severity: SEVERITY[d.level],
      message: d.message,
      startLineNumber: d.line,
      startColumn: column,
      endLineNumber: d.line,
      endColumn: column,
    });
  }
  return { problems, markers };
}
