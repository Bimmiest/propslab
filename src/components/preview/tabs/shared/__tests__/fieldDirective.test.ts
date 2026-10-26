// ---------------------------------------------------------------------------
// fieldDirective.test.ts
// "Jump to config" finds the directive that made a field (#745), and
// "Create FIELDALIAS…" writes a directive the engine reads back.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { fieldAliasDirective, fieldDirectiveLine, processorsOf } from '../fieldDirective';
import { makeEvent } from '../../../../../test/makeEvent';
import { toViewResult } from '../../../../../utils/viewResult';

const META = { index: 'main', host: 'h', source: 's', sourcetype: 'web' };

const PROPS = [
  '[web]', // 1
  'EXTRACT-user = user=(?<user>\\w+)', // 2
  'KV_MODE = json', // 3
  'FIELDALIAS-cim = src AS src_ip dst AS dest', // 4
  'EVAL-dur_ms = dur * 1000', // 5
  'REPORT-kv = kv_pairs', // 6
  '',
  '[other]', // 8
  'EXTRACT-user = nope=(?<user>.)', // 9
].join('\n');

describe('fieldDirectiveLine', () => {
  const at = (field: string, ...processors: string[]) => fieldDirectiveLine(field, processors, PROPS, [META]);

  it('finds the directive a step is named for, in the stanza the event matched', () => {
    expect(at('user', 'EXTRACT-user')).toBe(2);
    expect(at('a', 'KV_MODE(json)')).toBe(3);
    expect(at('k', 'REPORT-kv:kv_pairs')).toBe(6);
  });

  it('picks the EVAL and the FIELDALIAS by the field, as those steps cover every directive of their kind', () => {
    expect(at('dur_ms', 'EVAL')).toBe(5);
    expect(at('dest', 'FIELDALIAS')).toBe(4);
    expect(at('src', 'FIELDALIAS')).toBeNull();
  });

  it('gives null for a step props.conf has no line for', () => {
    expect(at('x', 'INGEST_EVAL')).toBeNull();
    expect(at('host', 'metadata')).toBeNull();
    expect(at('user')).toBeNull();
    expect(fieldDirectiveLine('a', ['KV_MODE(auto)'], '[web]\nEXTRACT-x = (?<x>.)', [META])).toBeNull();
  });

  it('tries the metadata in order, for a rename target before the original', () => {
    const renamed = { ...META, sourcetype: 'other' };
    expect(fieldDirectiveLine('user', ['EXTRACT-user'], PROPS, [renamed, META])).toBe(9);
  });
});

describe('processorsOf', () => {
  it('reads the steps that added the field from the first event that has it', () => {
    const view = toViewResult({
      events: [
        makeEvent('', { fields: { a: '1' } }),
        makeEvent('', {
          fields: { b: '2' },
          processingTrace: [
            { processor: 'EXTRACT-b', phase: 'search-time', description: '', fieldsAdded: ['b'] },
            { processor: 'EVAL', phase: 'search-time', description: '', fieldsAdded: ['c'] },
          ],
        }),
      ],
      originalRaw: '',
      eventCount: 2,
      processingSteps: [],
      inputMetadata: META,
    });
    expect(processorsOf('b', view.events)).toEqual(['EXTRACT-b']);
    expect(processorsOf('missing', view.events)).toEqual([]);
  });
});

describe('fieldAliasDirective', () => {
  it('names the class after the alias and quotes names that need it', () => {
    expect(fieldAliasDirective('src', 'src_ip')).toEqual({ key: 'FIELDALIAS-src_ip', value: 'src AS src_ip' });
    expect(fieldAliasDirective('event.user', 'user')).toEqual({
      key: 'FIELDALIAS-user',
      value: "'event.user' AS user",
    });
    expect(fieldAliasDirective('a', 'b.c')).toEqual({ key: 'FIELDALIAS-b_c', value: "a AS 'b.c'" });
  });
});
