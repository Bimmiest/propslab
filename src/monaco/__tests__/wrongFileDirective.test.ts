// #278: an attribute written in the conf file it does not belong to got two
// verdicts that contradicted each other and were both wrong -- the engine said
// "recognised but not simulated" (or nothing, for a simulated key) and the
// editor said "possible typo?". Each surface now says one thing, the same thing:
// which file the line belongs in. Lives beside the editor tests because the
// point is that the two validators agree.
import { describe, it, expect } from 'vitest';
import type { editor } from 'monaco-editor';
import { computeDiagnostics } from '../splunkConfDiagnostics';
import { runPipeline } from '../../engine/pipeline';
import { wrongFileCanonical } from '../../engine/directiveRegistry';
import type { EventMetadata, ValidationDiagnostic } from '../../engine/types';

function fakeModel(text: string): editor.ITextModel {
  const lines = text.split('\n');
  return {
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getValue: () => text,
  } as unknown as editor.ITextModel;
}

const metadata: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function engineDiagnostics(props: string, transforms: string): ValidationDiagnostic[] {
  return runPipeline('2026-01-15T10:00:00Z hello\n', metadata, props, transforms, {
    perEventPipeline: false,
    captureOffsets: false,
  }).diagnostics;
}

/** Every diagnostic either surface puts on `line` of `file`. */
function onLine(
  file: 'props.conf' | 'transforms.conf',
  props: string,
  transforms: string,
  line: number,
) {
  const text = file === 'props.conf' ? props : transforms;
  return {
    engine: engineDiagnostics(props, transforms).filter((d) => d.file === file && d.line === line),
    editor: computeDiagnostics(fakeModel(text), file).filter((m) => m.startLineNumber === line),
  };
}

describe('wrongFileCanonical (#278)', () => {
  it('names the other file for an attribute that only exists there', () => {
    expect(wrongFileCanonical('CAN_OPTIMIZE_IE', 'props.conf')).toBe('transforms.conf');
    expect(wrongFileCanonical('KV_MODE', 'transforms.conf')).toBe('props.conf');
  });

  it('resolves a class-based key by its prefix', () => {
    expect(wrongFileCanonical('EXTRACT-foo', 'transforms.conf')).toBe('props.conf');
  });

  it('says nothing for a key that is valid where it is written', () => {
    expect(wrongFileCanonical('CAN_OPTIMIZE_IE', 'transforms.conf')).toBeUndefined();
    expect(wrongFileCanonical('EXTRACT-foo', 'props.conf')).toBeUndefined();
    // Registered for both files.
    expect(wrongFileCanonical('MATCH_LIMIT', 'props.conf')).toBeUndefined();
    expect(wrongFileCanonical('MATCH_LIMIT', 'transforms.conf')).toBeUndefined();
  });

  it('says nothing for a key neither file defines, or a mis-cased one', () => {
    expect(wrongFileCanonical('NOT_A_REAL_DIRECTIVE', 'props.conf')).toBeUndefined();
    expect(wrongFileCanonical('can_optimize_ie', 'props.conf')).toBeUndefined();
  });
});

describe('an attribute in the wrong conf file gets one, agreeing, diagnostic per surface (#278)', () => {
  it('CAN_OPTIMIZE_IE in props.conf', () => {
    // Previously: engine "recognised but not simulated ... Tracked as #275",
    // editor "Unknown directive ... possible typo?".
    const props = '[st]\nCAN_OPTIMIZE_IE = true\n';
    const { engine, editor } = onLine('props.conf', props, '', 2);
    const expected = 'CAN_OPTIMIZE_IE belongs in transforms.conf; in props.conf it has no effect.';

    expect(engine).toHaveLength(1);
    expect(engine[0]).toMatchObject({ level: 'warning', message: expected, directiveKey: 'CAN_OPTIMIZE_IE' });
    expect(editor).toHaveLength(1);
    expect(editor[0]).toMatchObject({ severity: 4, message: expected });
  });

  it('STOP_PROCESSING_IF in props.conf is not reported as unsimulated', () => {
    const props = '[st]\nSTOP_PROCESSING_IF = true\n';
    const { engine, editor } = onLine('props.conf', props, '', 2);
    expect(engine.map((d) => d.message)).toEqual([
      'STOP_PROCESSING_IF belongs in transforms.conf; in props.conf it has no effect.',
    ]);
    expect(editor.map((m) => m.message)).toEqual(engine.map((d) => d.message));
  });

  it('a props.conf-only attribute in transforms.conf', () => {
    // KV_MODE is simulated, so the engine used to say nothing at all here and
    // the only word the user got was the editor's "possible typo?".
    const props = '[st]\nTRANSFORMS-x = t1\n';
    const transforms = '[t1]\nREGEX = (x)\nFORMAT = a::$1\nKV_MODE = json\n';
    const { engine, editor } = onLine('transforms.conf', props, transforms, 4);
    const expected = 'KV_MODE belongs in props.conf; in transforms.conf it has no effect.';

    expect(engine).toHaveLength(1);
    expect(engine[0]).toMatchObject({ level: 'warning', message: expected });
    expect(editor).toHaveLength(1);
    expect(editor[0]).toMatchObject({ severity: 4, message: expected });
  });

  it('a class-based props.conf key in transforms.conf, LOOKUP included', () => {
    // LOOKUP- is skipped by the per-attribute loop because props.conf has its
    // own LOOKUP warning; that one never looks at transforms.conf.
    const props = '[st]\nTRANSFORMS-x = t1\n';
    const transforms = '[t1]\nREGEX = (x)\nFORMAT = a::$1\nLOOKUP-l = t f\n';
    const { engine, editor } = onLine('transforms.conf', props, transforms, 4);
    expect(engine.map((d) => d.message)).toEqual([
      'LOOKUP-l belongs in props.conf; in transforms.conf it has no effect.',
    ]);
    expect(editor.map((m) => m.message)).toEqual(engine.map((d) => d.message));
  });

  it('leaves the right-file diagnostics alone', () => {
    const transforms = '[t1]\nREGEX = (x)\nCAN_OPTIMIZE_IE = true\n';
    const engine = engineDiagnostics('[st]\nREPORT-x = t1\n', transforms).filter(
      (d) => d.directiveKey === 'CAN_OPTIMIZE_IE',
    );
    expect(engine).toHaveLength(1);
    expect(engine[0]?.message).toContain('not simulated');
    expect(computeDiagnostics(fakeModel(transforms), 'transforms.conf')).toEqual([]);
  });
});
