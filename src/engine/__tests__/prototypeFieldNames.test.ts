import { describe, it, expect } from 'vitest';
import { extractFields } from '../processors/fieldExtractor';
import { applyFieldAliases } from '../processors/fieldAlias';
import { applyEvalExpressions } from '../processors/evalProcessor';
import { applyIngestEval } from '../transforms/ingestEval';
import { applyIndexedExtractions } from '../processors/indexedExtractions';
import { hasField } from '../utils/fieldBag';
import type { ConfDirective, SplunkEvent } from '../types';
import { runCtx } from './runCtx';

// A plain object inherits every Object.prototype member, so `fields[name]`
// reads back a FUNCTION for names like `toString` / `constructor`. Every
// processor goes through fieldBag.ts, which prevents exactly this.
//
// Splunk extracts such names verbatim (they are ordinary JSON/KV keys), so the
// correct behaviour is "treated as any other field", not "rejected".
const PROTO_NAMES = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];

const ev = (raw: string, fields: Record<string, string | string[]> = {}): SplunkEvent => ({
  _raw: raw,
  _time: null,
  _meta: {},
  fields,
  metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
  lineNumbers: { start: 1, end: 1 },
  processingTrace: [],
});

const dir = (key: string, value: string, directiveType: string, className?: string): ConfDirective =>
  ({ key, value, line: 1, directiveType, ...(className ? { className } : {}) });

describe('EXTRACT — a capture group named after an Object.prototype member (#120)', () => {
  it.each(PROTO_NAMES)('extracts (?<%s>…) as an ordinary field', (name) => {
    const r = extractFields(
      [ev('v=hello')],
      [dir('EXTRACT-a', `v=(?<${name}>\\w+)`, 'EXTRACT', 'a')],
      runCtx(),
    )[0]!;
    expect(hasField(r.fields, name)).toBe(true);
    expect(r.fields[name]).toBe('hello');
  });

  it('records the offset for such a field too', () => {
    const r = extractFields(
      [ev('v=hello')],
      [dir('EXTRACT-a', 'v=(?<toString>\\w+)', 'EXTRACT', 'a')],
      runCtx(),
    )[0]!;
    expect(r.fieldOffsets?.toString).toEqual([[2, 7]]);
  });
});

describe('FIELDALIAS — never binds an inherited member (#120)', () => {
  it('does not alias a field that does not exist', () => {
    const r = applyFieldAliases(
      [ev('hello')],
      [dir('FIELDALIAS-x', 'toString AS dvc', 'FIELDALIAS', 'x')],
      runCtx(),
    )[0]!;
    // Previously `dvc` was set to Object.prototype.toString — a JS function in
    // the field bag, which then fails to structured-clone out of the worker.
    expect(hasField(r.fields, 'dvc')).toBe(false);
  });

  it('aliases a real field of that name', () => {
    const r = applyFieldAliases(
      [ev('hello', { toString: 'real-value' })],
      [dir('FIELDALIAS-x', 'toString AS dvc', 'FIELDALIAS', 'x')],
      runCtx(),
    )[0]!;
    expect(r.fields['dvc']).toBe('real-value');
  });

  it('ASNEW does not treat an inherited member as an existing target', () => {
    const r = applyFieldAliases(
      [ev('hello', { src: 'v' })],
      [dir('FIELDALIAS-x', 'src ASNEW toString', 'FIELDALIAS', 'x')],
      runCtx(),
    )[0]!;
    expect(r.fields.toString).toBe('v');
  });
});

describe('EVAL — reads and writes such names as fields (#120)', () => {
  it('isnull() on a non-existent prototype-named field is true', () => {
    const r = applyEvalExpressions(
      [ev('x')],
      [dir('EVAL-out', 'if(isnull(toString), "absent", "present")', 'EVAL', 'out')],
      runCtx(),
    )[0]!;
    expect(r.fields['out']).toBe('absent');
  });

  it('writes a computed field with a prototype-colliding name', () => {
    const r = applyEvalExpressions(
      [ev('x')],
      [dir('EVAL-constructor', '"computed"', 'EVAL', 'constructor')],
      runCtx(),
    )[0]!;
    expect(r.fields.constructor).toBe('computed');
  });
});

describe('INGEST_EVAL / INDEXED_EXTRACTIONS — same names, same treatment (#120)', () => {
  it('INGEST_EVAL assigns a prototype-colliding field', () => {
    const r = applyIngestEval([ev('x')], [dir('INGEST_EVAL', 'valueOf="v"', 'INGEST_EVAL')], runCtx())[0]!;
    expect(r.fields.valueOf).toBe('v');
  });

  it('CSV header colliding with a prototype member becomes a field', () => {
    const events = [ev('toString,b'), ev('1,2')];
    const r = applyIndexedExtractions(events, [
      dir('INDEXED_EXTRACTIONS', 'csv', 'INDEXED_EXTRACTIONS'),
    ], runCtx())[0]!;
    expect(r.fields.toString).toBe('1');
    expect(r.fields['b']).toBe('2');
  });
});
