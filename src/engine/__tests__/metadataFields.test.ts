import { describe, it, expect } from 'vitest';
import { extractFields } from '../processors/fieldExtractor';
import { applyFieldAliases } from '../processors/fieldAlias';
import { applyEvalExpressions } from '../processors/evalProcessor';
import type { SplunkEvent, ConfDirective } from '../types';
import { runCtx } from './runCtx';

function event(raw = 'hello'): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'web01', source: '/var/log/app/api.log', sourcetype: 'app:api' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

const dir = (key: string, value: string, directiveType: string, className?: string): ConfDirective =>
  ({ key, value, line: 1, directiveType, className });

// host/source/sourcetype/index are default fields at search time, so a
// large family of staple TA/CIM directives can read them without any prior
// extraction.
describe('metadata as search-time default fields (#56)', () => {
  it('EXTRACT ... in source reads the event source', () => {
    const out = extractFields(
      [event()],
      [dir('EXTRACT-app', '/var/log/(?<app>\\w+)/ in source', 'EXTRACT', 'app')],
      runCtx(),
    )[0]!;
    expect(out.fields.app).toBe('app');
  });

  it('FIELDALIAS host AS dvc aliases the metadata host', () => {
    const out = applyFieldAliases([event()], [dir('FIELDALIAS-cim', 'host AS dvc', 'FIELDALIAS', 'cim')], runCtx())[0]!;
    expect(out.fields.dvc).toBe('web01');
  });

  it('EVAL can read source, host, sourcetype and index', () => {
    const out = applyEvalExpressions(
      [event()],
      [
        dir('EVAL-s', 'source', 'EVAL', 's'),
        dir('EVAL-h', 'host', 'EVAL', 'h'),
        dir('EVAL-st', 'sourcetype', 'EVAL', 'st'),
        dir('EVAL-i', 'index', 'EVAL', 'i'),
      ],
      runCtx(),
    )[0]!;
    expect(out.fields.s).toBe('/var/log/app/api.log');
    expect(out.fields.h).toBe('web01');
    expect(out.fields.st).toBe('app:api');
    expect(out.fields.i).toBe('main');
  });

  it('an extracted field of the same name still wins', () => {
    const ev = { ...event(), fields: { host: 'from-payload' } };
    const out = applyFieldAliases([ev], [dir('FIELDALIAS-x', 'host AS dvc', 'FIELDALIAS', 'x')], runCtx())[0]!;
    expect(out.fields.dvc).toBe('from-payload');
  });

  it('leaves an unrelated missing field unresolved', () => {
    const out = applyEvalExpressions([event()], [dir('EVAL-x', 'nosuchfield', 'EVAL', 'x')], runCtx())[0]!;
    expect(out.fields.x).toBeUndefined();
  });
});
