// ---------------------------------------------------------------------------
// editorProblems.test.ts
// The one list of problems per editor (#899): the linter's markers and the
// run's diagnostics, with a run diagnostic dropped where the linter already
// marks its line at its level or above.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { fileProblems, lintConf, textLines } from '../editorProblems';
import { computeDiagnostics, MISSPELLED_MARKER_CODE, type DiagnosticMarker } from '../splunkConfDiagnostics';
import { type ValidationDiagnostic, runPipeline, SAMPLE_CONFIGS } from '../../engine';
import { AT_FIXED_NOW } from '../../test/runCtx';
import { countByLevel } from '../../utils/diagnosticCounts';
import { fakeModel } from '../../test/fakeModel';

function marker(line: number, severity: DiagnosticMarker['severity'], message = `lint ${line}`): DiagnosticMarker {
  return { severity, message, startLineNumber: line, startColumn: 3, endLineNumber: line, endColumn: 9 };
}

function diag(
  line: number | undefined,
  level: ValidationDiagnostic['level'],
  file: ValidationDiagnostic['file'] = 'props.conf',
): ValidationDiagnostic {
  return { level, message: `run ${line ?? '-'}`, file, ...(line === undefined ? {} : { line }) };
}

describe('textLines', () => {
  it('splits where the model splits, LF, CRLF or a bare CR', () => {
    const lines = textLines('a\r\nb\rc\nd');
    expect(lines.getLineCount()).toBe(4);
    expect([1, 2, 3, 4].map((n) => lines.getLineContent(n))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reads a line past the end as empty', () => {
    expect(textLines('a').getLineContent(2)).toBe('');
  });

  it('lints as the model does', () => {
    const text = '[st]\nkv_mode = auto\nTIME_FROMAT = %Y\ngarbage\n';
    expect(computeDiagnostics(textLines(text), 'props.conf')).toEqual(
      computeDiagnostics(fakeModel(text), 'props.conf'),
    );
  });
});

describe('lintConf', () => {
  it('answers the same text from the last lint, and lints a new text again', () => {
    const first = lintConf('[st]\ngarbage\n', 'props.conf');
    expect(lintConf('[st]\ngarbage\n', 'props.conf')).toBe(first);
    expect(first.map((m) => m.startLineNumber)).toEqual([2]);
    const second = lintConf('[st]\nKV_MODE = auto\n', 'props.conf');
    expect(second).toEqual([]);
    expect(lintConf('[st]\ngarbage\n', 'props.conf')).not.toBe(first);
  });

  it('keeps the last lint of each file apart, and lints as that file', () => {
    const props = lintConf('[t]\nREGEX = (a)\n', 'props.conf');
    const transforms = lintConf('[t]\nREGEX = (a)\n', 'transforms.conf');
    expect(props).toHaveLength(1);
    expect(transforms).toEqual([]);
    expect(lintConf('[t]\nREGEX = (a)\n', 'props.conf')).toBe(props);
  });
});

describe('fileProblems', () => {
  it('lists the linter markers as problems of the file, at their line and column', () => {
    const { problems, markers } = fileProblems('props.conf', [marker(2, 8), marker(3, 4), marker(4, 2)], []);
    expect(problems).toEqual([
      { level: 'error', message: 'lint 2', file: 'props.conf', line: 2, column: 3 },
      { level: 'warning', message: 'lint 3', file: 'props.conf', line: 3, column: 3 },
      { level: 'info', message: 'lint 4', file: 'props.conf', line: 4, column: 3 },
    ]);
    expect(markers).toHaveLength(3);
  });

  it('reads a hint as info', () => {
    expect(fileProblems('props.conf', [marker(1, 1)], []).problems[0]?.level).toBe('info');
  });

  it('keeps only the run diagnostics of its own file', () => {
    const { problems } = fileProblems('props.conf', [], [diag(1, 'warning'), diag(2, 'warning', 'transforms.conf')]);
    expect(problems.map((p) => p.message)).toEqual(['run 1']);
  });

  it('drops a run diagnostic where the linter marks its line at its level or above', () => {
    const lint = [marker(2, 8), marker(3, 4), marker(4, 2)];
    const run = [diag(2, 'warning'), diag(2, 'error'), diag(3, 'warning'), diag(3, 'error'), diag(4, 'info')];
    const { problems } = fileProblems('props.conf', lint, run);
    expect(problems.map((p) => p.message)).toEqual(['lint 2', 'lint 3', 'run 3', 'lint 4']);
  });

  it('keeps a run diagnostic above the level of the linter on its line', () => {
    const { problems } = fileProblems('props.conf', [marker(5, 2)], [diag(5, 'warning')]);
    expect(problems.map((p) => p.message)).toEqual(['lint 5', 'run 5']);
  });

  it('reads the strongest of the markers on a line', () => {
    const { problems } = fileProblems('props.conf', [marker(5, 2), marker(5, 8), marker(5, 4)], [diag(5, 'error')]);
    expect(problems.map((p) => p.message)).not.toContain('run 5');
  });

  it('keeps a run diagnostic with no line, first, and marks it nowhere', () => {
    const { problems, markers } = fileProblems('props.conf', [marker(1, 8)], [diag(undefined, 'error')]);
    expect(problems.map((p) => p.message)).toEqual(['run -', 'lint 1']);
    expect(markers).toHaveLength(1);
  });

  it('orders the rows by line, the linter and the run together', () => {
    const { problems } = fileProblems(
      'props.conf',
      [marker(3, 8), marker(9, 8)],
      [diag(5, 'warning'), diag(1, 'info')],
    );
    expect(problems.map((p) => p.line)).toEqual([1, 3, 5, 9]);
  });

  it('marks a kept run diagnostic at its column, or at the start of its line', () => {
    const run = [diag(4, 'warning'), { ...diag(6, 'error'), column: 7 }, diag(7, 'info')];
    const { markers } = fileProblems('props.conf', [], run);
    expect(markers).toEqual([
      { severity: 4, message: 'run 4', startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 },
      { severity: 8, message: 'run 6', startLineNumber: 6, startColumn: 7, endLineNumber: 6, endColumn: 7 },
      { severity: 2, message: 'run 7', startLineNumber: 7, startColumn: 1, endLineNumber: 7, endColumn: 1 },
    ]);
  });

  it('keeps the linter markers as they are, codes and ranges', () => {
    const lint = [{ ...marker(2, 4), code: MISSPELLED_MARKER_CODE }];
    expect(fileProblems('props.conf', lint, []).markers).toEqual(lint);
  });

  it('lists the run diagnostics of the raw data, which has no linter', () => {
    const { problems } = fileProblems('raw', [], [diag(undefined, 'warning', 'raw')]);
    expect(problems).toHaveLength(1);
  });
});

// The repro of #899: the Linux SSH Auth example with five bad lines. The panel
// showed four rows for five defects, and the mistyped key had none.
describe('fileProblems — the five defects of #899', () => {
  const sample = SAMPLE_CONFIGS.find((c) => c.name === 'Linux SSH Auth');
  if (!sample) throw new Error('the Linux SSH Auth example is gone');
  const BAD = [
    'EXTRACT-bad = (?<x>[a-',
    'TIME_FROMAT = %Y',
    'LOOKUP-x = foo a OUTPUT b',
    'SEDCMD-y = s/a/b/2',
    'not a directive',
  ];
  const propsConf = `${sample.propsConf.replace(/\n*$/, '')}\n${BAD.join('\n')}\n`;
  const first = propsConf.split('\n').length - BAD.length - 1;
  const run = runPipeline(sample.rawData, sample.metadata, propsConf, sample.transformsConf, AT_FIXED_NOW).diagnostics;
  const { problems, markers } = fileProblems('props.conf', lintConf(propsConf, 'props.conf'), run);
  const bad = problems.filter((p) => p.line !== undefined && p.line >= first + 1);

  it('lists one row for each defect, at its line', () => {
    expect(bad.map((p) => p.line)).toEqual([1, 2, 3, 4, 5].map((n) => first + n));
  });

  it('has an error for the pattern that does not compile, and for the malformed line', () => {
    expect(bad.map((p) => p.level)).toEqual(['error', 'warning', 'warning', 'warning', 'error']);
    expect(bad[0]?.message).toMatch(/Invalid regex pattern/);
  });

  it('suggests the attribute for the mistyped key', () => {
    expect(bad[1]?.message).toMatch(/Did you mean "TIME_FORMAT"\?/);
  });

  it('marks in the editor what the panel lists, so the counts agree', () => {
    expect(markers.map((m) => m.startLineNumber).sort((a, b) => a - b)).toEqual(
      problems.flatMap((p) => (p.line === undefined ? [] : [p.line])),
    );
    const levels = countByLevel(problems);
    expect(levels.error).toBe(markers.filter((m) => m.severity === 8).length);
    expect(levels.warning).toBe(markers.filter((m) => m.severity === 4).length);
  });
});
