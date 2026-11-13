import { describe, it, expect } from 'vitest';
import type { DiagnosticLevel, ValidationDiagnostic } from 'propslab-engine';
import { countByLevel } from '../diagnosticCounts';

const diag = (level: DiagnosticLevel): ValidationDiagnostic => ({
  code: 'malformed-line',
  level,
  message: level,
  file: 'props.conf',
});

describe('countByLevel', () => {
  it('counts each level, and zero for a level that is absent', () => {
    expect(countByLevel([diag('error'), diag('warning'), diag('error')])).toEqual({ error: 2, warning: 1, info: 0 });
    expect(countByLevel([])).toEqual({ error: 0, warning: 0, info: 0 });
  });
});
