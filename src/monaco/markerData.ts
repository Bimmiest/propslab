// ---------------------------------------------------------------------------
// markerData.ts
// The conf linter's markers, as the marker data Monaco takes.
//
// computeDiagnostics stays free of Monaco's runtime, so its severities are
// plain numbers. Monaco's are an enum, and this is where one becomes the other:
// through the runtime enum, as the completion provider does for its kinds, not
// by trusting that the numbers happen to line up.
// ---------------------------------------------------------------------------

import type { editor } from 'monaco-editor';
import { MarkerSeverity } from 'monaco-editor/editor';
import type { DiagnosticMarker } from './splunkConfDiagnostics';

const SEVERITY: Record<DiagnosticMarker['severity'], MarkerSeverity> = {
  8: MarkerSeverity.Error,
  4: MarkerSeverity.Warning,
  2: MarkerSeverity.Info,
  1: MarkerSeverity.Hint,
};

export function toMarkerData(markers: readonly DiagnosticMarker[]): editor.IMarkerData[] {
  return markers.map(({ severity, ...rest }) => ({ ...rest, severity: SEVERITY[severity] }));
}
