// ---------------------------------------------------------------------------
// evalTraceFields.test.ts
// What the trace step of a search-time stage says it did to each field: added
// (new), modified (the event had it before) or removed. A no-op is not in the
// step (ADR 0010), and an unknown eval function fails the expression.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { applyEvalExpressions } from '../processors/evalProcessor';
import { runPipeline } from '../pipeline';
import { SAMPLE_CONFIGS } from '../sampleData';
import { unsimulatedNames, builtinNames } from '../processors/eval/builtins';
import type { ConfDirective, EventMetadata, SplunkEvent, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW, AT_FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

const evalDir = (field: string, expr: string, line = 1): ConfDirective => ({
  key: `EVAL-${field}`,
  value: expr,
  line,
  directiveType: 'EVAL',
  className: field,
});

function runEval(fields: Record<string, string>, dirs: ConfDirective[], diagnostics: ValidationDiagnostic[] = []) {
  const [event] = applyEvalExpressions([makeEvent('raw', { fields })], dirs, runCtx(FIXED_NOW, diagnostics));
  return event as SplunkEvent;
}

const evalSteps = (e: SplunkEvent) => e.processingTrace.filter((s) => s.processor === 'EVAL');

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

describe('EVAL — a null result is not in the trace (#876)', () => {
  it('adds no step when every expression is null, and lists each in noOps', () => {
    const e = runEval({}, [evalDir('x', 'null()', 3), evalDir('y', 'len(missing)', 4)]);
    expect(evalSteps(e)).toEqual([]);
    expect(e.fields).toEqual({});
    expect(e.noOps?.map((n) => [n.directive, n.line, n.reason.kind])).toEqual([
      ['EVAL-x', 3, 'eval-null'],
      ['EVAL-y', 4, 'eval-null'],
    ]);
  });

  it('keeps a null field out of a step that computed another field', () => {
    const e = runEval({}, [evalDir('x', 'null()'), evalDir('ok', '"v"')]);
    const [step] = evalSteps(e);
    expect(step?.fieldsAdded).toEqual(['ok']);
    expect(step?.description).toBe('Computed fields: ok');
    expect(step?.evalExpressions).toEqual({ ok: '"v"' });
    expect(step).not.toHaveProperty('fieldsModified');
    expect(step).not.toHaveProperty('fieldsRemoved');
    expect(e.noOps?.map((n) => n.directive)).toEqual(['EVAL-x']);
  });

  it('records a null over a field the event had as a removal, not a no-op', () => {
    const e = runEval({ x: 'old' }, [evalDir('x', 'null()')]);
    expect(e.fields).toEqual({});
    const [step] = evalSteps(e);
    expect(step?.fieldsAdded).toEqual([]);
    expect(step?.fieldsRemoved).toEqual(['x']);
    expect(step?.description).toBe('Removed fields (null): x');
    expect(step?.evalExpressions).toEqual({ x: 'null()' });
    expect(e.noOps).toBeUndefined();
  });

  it('agrees with noOps through runPipeline (the reproduction in #876)', () => {
    const { result, diagnostics } = runPipeline(
      'hello\n',
      META,
      '[st]\nEVAL-x = null()\nEVAL-y = lenn(_raw)\n',
      '',
      AT_FIXED_NOW,
    );
    const [event] = result.events;
    expect(event?.processingTrace.filter((s) => s.processor === 'EVAL')).toEqual([]);
    expect(event?.fields).not.toHaveProperty('x');
    expect(event?.fields).not.toHaveProperty('y');
    expect(event?.noOps?.map((n) => n.directive)).toEqual(['EVAL-x']);
    const messages = diagnostics.map((d) => `${d.level}: ${d.message}`);
    expect(messages).toContain('error: EVAL-y: lenn() is not an eval function');
    expect(messages.some((m) => m.includes('not fully simulated'))).toBe(false);
  });
});

describe('EVAL — a field the event had before is modified, not added (#900)', () => {
  it('splits written fields by whether the event had them', () => {
    const e = runEval({ action: 'allow' }, [
      evalDir('action', 'if(action=="allow", "allowed", "blocked")'),
      evalDir('fresh', '"v"'),
    ]);
    expect(e.fields).toMatchObject({ action: 'allowed', fresh: 'v' });
    const [step] = evalSteps(e);
    expect(step?.fieldsAdded).toEqual(['fresh']);
    expect(step?.fieldsModified).toEqual(['action']);
    expect(step?.description).toBe('Computed fields: fresh; Changed fields: action');
    expect(Object.keys(step?.evalExpressions ?? {})).toEqual(['action', 'fresh']);
  });

  it('counts a field as modified when the new value is the same', () => {
    const [step] = evalSteps(runEval({ a: '1' }, [evalDir('a', 'a')]));
    expect(step?.fieldsAdded).toEqual([]);
    expect(step?.fieldsModified).toEqual(['a']);
    expect(step?.description).toBe('Changed fields: a');
  });

  it('reads the event as it was before the step: the expressions run in parallel', () => {
    // EVAL-b reads a, which EVAL-a also writes; neither field existed for b.
    const [step] = evalSteps(runEval({}, [evalDir('a', '"1"'), evalDir('b', '"2"')]));
    expect(step?.fieldsAdded).toEqual(['a', 'b']);
    expect(step).not.toHaveProperty('fieldsModified');
  });

  it('marks EVAL-action in the Palo Alto example as modified, after REPORT added it', () => {
    const pan = SAMPLE_CONFIGS.find((s) => s.name === 'Palo Alto Firewall');
    if (!pan) throw new Error('the Palo Alto example is missing');
    const meta = { ...META, sourcetype: 'pan:traffic' };
    const { result } = runPipeline(pan.rawData, meta, pan.propsConf, pan.transformsConf, AT_FIXED_NOW);
    const [event] = result.events;
    const trace = event?.processingTrace ?? [];
    const report = trace.find((s) => s.processor.startsWith('REPORT-pan_traffic'));
    const evalStep = trace.find((s) => s.processor === 'EVAL');
    expect(report?.fieldsAdded).toContain('action');
    expect(evalStep?.fieldsModified).toEqual(['action']);
    expect(evalStep?.fieldsAdded).toEqual(['bytes_total', 'vendor_product']);
  });
});

describe('the other search-time steps — written-over fields are modified (#900)', () => {
  it('REPORT: a field an earlier extraction set is modified', () => {
    const props = '[st]\nEXTRACT-a = ^(?<word>\\w+)\nREPORT-b = again\n';
    const transforms = '[again]\nREGEX = (?<word>\\w+)$\n';
    const { result } = runPipeline('first last\n', META, props, transforms, AT_FIXED_NOW);
    const step = result.events[0]?.processingTrace.find((s) => s.processor.startsWith('REPORT-b'));
    expect(step?.fieldsAdded).toEqual([]);
    expect(step?.fieldsModified).toEqual(['word']);
  });

  it('REPORT: a new field is added, with no fieldsModified', () => {
    const transforms = '[again]\nREGEX = (?<word>\\w+)$\n';
    const { result } = runPipeline('first last\n', META, '[st]\nREPORT-b = again\n', transforms, AT_FIXED_NOW);
    const step = result.events[0]?.processingTrace.find((s) => s.processor.startsWith('REPORT-b'));
    expect(step?.fieldsAdded).toEqual(['word']);
    expect(step).not.toHaveProperty('fieldsModified');
  });

  it('KV_MODE = xml: an element that appends to an extracted field is modified', () => {
    const props = '[st]\nKV_MODE = xml\nREPORT-u = u\n';
    const transforms = '[u]\nREGEX = <user>(\\w+)\nFORMAT = r.user::$1\nCLEAN_KEYS = false\n';
    const { result } = runPipeline('<r><user>ann</user><id>7</id></r>\n', META, props, transforms, AT_FIXED_NOW);
    const [event] = result.events;
    expect(event?.fields['r.user']).toEqual(['ann', 'ann']);
    const step = event?.processingTrace.find((s) => s.processor === 'KV_MODE(xml)');
    expect(step?.fieldsAdded).toEqual(['r.id']);
    expect(step?.fieldsModified).toEqual(['r.user']);
  });
});

describe('eval — an unknown function name fails the expression (#876)', () => {
  it('is an error that names the function, and writes no field', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const e = runEval({ x: 'old' }, [evalDir('x', 'lenn(x)')], diagnostics);
    expect(e.fields).toEqual({ x: 'old' });
    expect(evalSteps(e)).toEqual([]);
    expect(e.noOps).toBeUndefined();
    expect(diagnostics.map((d) => [d.level, d.message])).toEqual([['error', 'EVAL-x: lenn() is not an eval function']]);
  });

  it('fails the whole expression, even when the call is in an untaken position of a non-branching function', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    runEval({}, [evalDir('x', 'coalesce("a", nosuch())'), evalDir('y', '"b" . nosuch()')], diagnostics);
    // coalesce() returns at "a" and never evaluates nosuch(): only y fails.
    expect(diagnostics.map((d) => d.message)).toEqual(['EVAL-y: nosuch() is not an eval function']);
  });

  // Doc-derived: Splunk Search Reference, "Evaluation functions" — the list of
  // functions by category. These are real functions that the simulator does
  // not compute, so they warn and do not fail.
  it.each(['printf', 'json_extract', 'mvmap', 'atan2', 'bit_and', 'spath'])(
    '%s() is a Splunk function: it warns that it is not simulated',
    (fn) => {
      const diagnostics: ValidationDiagnostic[] = [];
      runEval({}, [evalDir('x', `${fn}("a")`)], diagnostics);
      expect(diagnostics.map((d) => [d.level, d.message])).toEqual([
        ['warning', `${fn}() is not fully simulated — results may differ from real Splunk`],
      ]);
    },
  );

  it('keeps the list of unsimulated functions apart from the builtins', () => {
    const builtins = new Set(builtinNames());
    expect(unsimulatedNames().filter((fn) => builtins.has(fn))).toEqual([]);
  });

  it('fails INGEST_EVAL and STOP_PROCESSING_IF the same way', () => {
    const props = '[st]\nTRANSFORMS-t = ie, stop\n';
    const transforms =
      '[ie]\nINGEST_EVAL = x=lenn(_raw)\n\n[stop]\nINGEST_EVAL = y="1"\nSTOP_PROCESSING_IF = lenn(_raw) > 1\n';
    const { diagnostics } = runPipeline('hello\n', META, props, transforms, AT_FIXED_NOW);
    const errors = diagnostics.filter((d) => d.level === 'error').map((d) => d.message);
    expect(errors.some((m) => m.includes('INGEST_EVAL') && m.includes('lenn() is not an eval function'))).toBe(true);
    expect(errors.some((m) => m.includes('STOP_PROCESSING_IF') && m.includes('lenn() is not an eval function'))).toBe(
      true,
    );
    expect(diagnostics.some((d) => d.message.includes('lenn() is not fully simulated'))).toBe(false);
  });
});
