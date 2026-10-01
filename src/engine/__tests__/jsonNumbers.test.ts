// ---------------------------------------------------------------------------
// jsonNumbers.test.ts
// A JSON number's field value is the number as the event wrote it (#448), by
// every route the engine extracts JSON, through runPipeline.
//
// Not doc-derived: props.conf.spec does not say how a number is rendered. A JS
// number would lose the digits past 2^53 and render `10.50` as `10.5`.
// flattenJson.test.ts covers the parser on its own.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
const NOW = Date.parse('2026-01-20T00:00:00Z');

function fieldsOf(raw: string, body: string): Record<string, string | string[]> {
  const { events } = runPipeline(raw, META, `[st]\nSHOULD_LINEMERGE = false\n${body}`, '', {
    perEventPipeline: false,
    captureOffsets: false,
    now: NOW,
  }).result;
  return events[0]?.fields ?? {};
}

const EVENT =
  '{"big":9007199254740993,"dec":10.50,"exp":1e3,"expu":1E+3,"huge":123456789012345678901234567890,' +
  '"negz":-0.0,"small":1E-7,"str":"10.50","int":42,"vals":[1.50,2e2],"items":[{"n":0.10}]}';

const AS_WRITTEN = {
  big: '9007199254740993',
  dec: '10.50',
  exp: '1e3',
  expu: '1E+3',
  huge: '123456789012345678901234567890',
  negz: '-0.0',
  small: '1E-7',
  str: '10.50',
  int: '42',
  'vals{}': ['1.50', '2e2'],
  'items{}.n': '0.10',
};

describe('JSON numbers keep their text through the pipeline (#448)', () => {
  it('KV_MODE = json', () => {
    expect(fieldsOf(EVENT, 'KV_MODE = json\n')).toMatchObject(AS_WRITTEN);
  });

  it('KV_MODE = json, on an object embedded in other text', () => {
    expect(fieldsOf('level=info payload={"dec":10.50,"vals":[1e3]}', 'KV_MODE = json\n')).toMatchObject({
      dec: '10.50',
      'vals{}': '1e3',
    });
  });

  it('INDEXED_EXTRACTIONS = json', () => {
    expect(fieldsOf(EVENT, 'INDEXED_EXTRACTIONS = json\nKV_MODE = none\n')).toMatchObject(AS_WRITTEN);
  });

  it('INDEXED_EXTRACTIONS = json, with JSON_TRIM_BRACES_IN_ARRAY_NAMES', () => {
    const f = fieldsOf(EVENT, 'INDEXED_EXTRACTIONS = json\nKV_MODE = none\nJSON_TRIM_BRACES_IN_ARRAY_NAMES = true\n');
    expect(f['vals']).toEqual(['1.50', '2e2']);
    expect(f['items.n']).toBe('0.10');
  });

  // Automatic JSON extraction parses through the same function as the two
  // above, so the three cannot disagree on a value.
  it('automatic JSON extraction under KV_MODE = auto', () => {
    expect(fieldsOf(EVENT, '')).toMatchObject(AS_WRITTEN);
  });

  it('leaves the value usable as a number downstream', () => {
    const f = fieldsOf(EVENT, 'KV_MODE = json\nEVAL-twice = dec * 2\nFIELDALIAS-a = dec AS amount\n');
    expect(f['twice']).toBe('21');
    expect(f['amount']).toBe('10.50');
  });
});
