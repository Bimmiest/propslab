import { describe, it, expect } from 'vitest';
import { applyFieldAliases } from '../processors/fieldAlias';
import { applyEvalExpressions } from '../processors/evalProcessor';
import type { ConfDirective, SplunkEvent } from '../types';

const ev = (fields: Record<string, string | string[]> = {}): SplunkEvent => ({
  _raw: 'raw text', _time: null, _meta: {}, fields,
  metadata: { index: 'main', host: 'h1', source: 's', sourcetype: 'st' },
  lineNumbers: { start: 1, end: 1 }, processingTrace: [],
});
const dir = (key: string, value: string, directiveType: string, className: string): ConfDirective =>
  ({ key, value, line: 1, directiveType, className });

// Alias pairs are carried as data on the step, not parsed out of `description`,
// a display string.
describe('FIELDALIAS — the step carries its alias pairs as data (#128)', () => {
  it('records target/source structurally', () => {
    const r = applyFieldAliases(
      [ev({ src_ip: '10.0.0.1' })],
      [dir('FIELDALIAS-cim', 'src_ip AS src', 'FIELDALIAS', 'cim')],
    )[0]!;
    const step = r.processingTrace.find((t) => t.processor === 'FIELDALIAS')!;
    expect(step.fieldAliases).toEqual([{ target: 'src', source: 'src_ip' }]);
    expect(step.fieldsAdded).toEqual(['src']);
  });

  it('survives a field name containing a space, which the old regex could not', () => {
    const r = applyFieldAliases(
      [ev({ 'my field': 'v' })],
      [dir('FIELDALIAS-x', "'my field' AS dest", 'FIELDALIAS', 'x')],
    )[0]!;
    const step = r.processingTrace.find((t) => t.processor === 'FIELDALIAS')!;
    expect(step.fieldAliases).toEqual([{ target: 'dest', source: 'my field' }]);
  });

  it('still renders a readable description', () => {
    const r = applyFieldAliases(
      [ev({ host_name: 'h' })],
      [dir('FIELDALIAS-x', 'host_name AS dvc', 'FIELDALIAS', 'x')],
    )[0]!;
    const step = r.processingTrace.find((t) => t.processor === 'FIELDALIAS')!;
    expect(step.description).toBe('Created aliases: dvc (from host_name)');
  });

  it('records several pairs in order', () => {
    const r = applyFieldAliases(
      [ev({ a: '1', b: '2' })],
      [dir('FIELDALIAS-x', 'a AS x  b AS y', 'FIELDALIAS', 'x')],
    )[0]!;
    const step = r.processingTrace.find((t) => t.processor === 'FIELDALIAS')!;
    expect(step.fieldAliases).toEqual([
      { target: 'x', source: 'a' },
      { target: 'y', source: 'b' },
    ]);
  });
});

// EVAL expressions are carried on the step as they ran — after stanza scoping
// and continuations — not recovered from raw props.conf.
describe('EVAL — the step carries the expression behind each field (#129)', () => {
  it('maps each computed field to its expression', () => {
    const r = applyEvalExpressions(
      [ev({ bytes: '2048' })],
      [
        dir('EVAL-kb', 'bytes / 1024', 'EVAL', 'kb'),
        dir('EVAL-label', '"size:" . bytes', 'EVAL', 'label'),
      ],
    )[0]!;
    const step = r.processingTrace.find((t) => t.processor === 'EVAL')!;
    expect(step.evalExpressions).toEqual({
      kb: 'bytes / 1024',
      label: '"size:" . bytes',
    });
  });

  it('omits a field whose expression failed to evaluate', () => {
    const r = applyEvalExpressions(
      [ev({})],
      [dir('EVAL-ok', '"v"', 'EVAL', 'ok'), dir('EVAL-broken', 'len(', 'EVAL', 'broken')],
    )[0]!;
    const step = r.processingTrace.find((t) => t.processor === 'EVAL')!;
    expect(Object.keys(step.evalExpressions ?? {})).toEqual(['ok']);
  });

  it('keys agree with fieldsAdded', () => {
    const r = applyEvalExpressions(
      [ev({ n: '5' })],
      [dir('EVAL-double', 'n * 2', 'EVAL', 'double')],
    )[0]!;
    const step = r.processingTrace.find((t) => t.processor === 'EVAL')!;
    expect(Object.keys(step.evalExpressions ?? {})).toEqual(step.fieldsAdded);
  });
});
