// ---------------------------------------------------------------------------
// Deeply nested XML (#428). The reader accepts any depth, so the walkers over
// its tree must too, and one event that still fails must not cost the rest
// of the batch its fields.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

// Pass-through, except that a document containing <boom/> throws: stands in
// for any per-event failure the walkers cannot rule out.
vi.mock('../utils/xmlReader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/xmlReader')>();
  return {
    ...actual,
    parseXmlDocument: (input: string) => {
      if (input.includes('<boom/>')) throw new Error('boom');
      return actual.parseXmlDocument(input);
    },
  };
});

const metadata: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'xmltest' };
const DEPTH = 20_000;
const deep = `${'<a>'.repeat(DEPTH)}x${'</a>'.repeat(DEPTH)}`;
const deepPath = Array.from({ length: DEPTH }, () => 'a').join('.');
const normal = '<event><user>bob</user></event>';

function run(raw: string, props: string) {
  const { result, diagnostics } = runPipeline(raw, metadata, `[xmltest]\nSHOULD_LINEMERGE = false\nTRUNCATE = 0\n${props}`, '', {
    perEventPipeline: false,
    captureOffsets: false,
  });
  return { events: result.events, diagnostics };
}

describe('KV_MODE = xml on deep nesting (#428)', () => {
  it(`extracts the leaf of a ${DEPTH}-deep document`, () => {
    const result = run(`${deep}\n${normal}`, 'KV_MODE = xml\n');
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.fields[deepPath]).toBe('x');
    expect(result.events[1]!.fields['event.user']).toBe('bob');
  });

  it('keeps the other events when one fails', () => {
    const result = run(`<r><boom/></r>\n${normal}`, 'KV_MODE = xml\n');
    expect(result.events[1]!.fields['event.user']).toBe('bob');
    const errors = result.diagnostics.filter((d) => d.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: 'raw', line: 1 });
    expect(errors[0]!.message).toContain('boom');
  });
});

describe('INDEXED_EXTRACTIONS = xml on deep nesting (#428)', () => {
  const props =
    'INDEXED_EXTRACTIONS = xml\nXML_INDEXED_EXTRACTIONS_PIPELINE = typing\n' +
    'extraction_cutoff = 1000000\nKV_MODE = none\n';

  it(`extracts the leaf of a ${DEPTH}-deep document`, () => {
    const result = run(`${deep}\n${normal}`, props);
    expect(result.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.fields[deepPath]).toBe('x');
    expect(result.events[1]!.fields['event.user']).toBe('bob');
  });

  it('keeps the other events when one fails', () => {
    const result = run(`<r><boom/></r>\n${normal}`, props);
    expect(result.events[1]!.fields['event.user']).toBe('bob');
    const errors = result.diagnostics.filter((d) => d.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('boom');
  });
});
