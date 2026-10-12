// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { MarkerSeverity } from 'monaco-editor/editor';
import { toMarkerData } from '../markerData';
import type { DiagnosticMarker } from '../splunkConfDiagnostics';

const at = (severity: DiagnosticMarker['severity']): DiagnosticMarker => ({
  severity,
  message: 'm',
  startLineNumber: 3,
  startColumn: 1,
  endLineNumber: 3,
  endColumn: 5,
  code: 'c',
});

describe('toMarkerData', () => {
  it.each([
    [8, MarkerSeverity.Error],
    [4, MarkerSeverity.Warning],
    [2, MarkerSeverity.Info],
    [1, MarkerSeverity.Hint],
  ] as const)('maps severity %i to MarkerSeverity %i', (severity, expected) => {
    expect(toMarkerData([at(severity)])[0]?.severity).toBe(expected);
  });

  it('keeps the range, message and code as they were', () => {
    const { severity, ...rest } = at(4);
    expect(severity).toBe(4);
    expect(toMarkerData([at(4)])).toEqual([{ ...rest, severity: MarkerSeverity.Warning }]);
  });
});
