// ---------------------------------------------------------------------------
// pcreSemantics.test.ts
// PCRE semantics reach the pipeline. Doc-derived (pcre2pattern): each case is
// one where a JavaScript regex gives a different answer. The pattern-level cases are
// in utils/__tests__/splunkRegex.test.ts; these pin that the processors use
// the same engine.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
const run = (raw: string, props: string, transforms = '') =>
  runPipeline(raw, META, `[st]\nSHOULD_LINEMERGE = false\n${props}`, transforms, {
    perEventPipeline: false,
    now: Date.parse('2026-01-01T00:00:00Z'),
  });

describe('PCRE semantics in the pipeline', () => {
  it('LINE_BREAKER takes a possessive quantifier', () => {
    const { result } = run('a\n\nb\nc', 'LINE_BREAKER = ([\\r\\n]++)');
    expect(result.events.map((e) => e._raw)).toEqual(['a', 'b', 'c']);
  });

  it('SEDCMD `.` matches a carriage return, as it does under LF newlines', () => {
    const { result } = run('xa\rby', 'LINE_BREAKER = (\\n+)\nSEDCMD-cr = s/a.b/-/');
    expect(result.events[0]!._raw).toBe('x-y');
  });

  it('EXTRACT honours \\K and a conditional group', () => {
    const { result } = run(
      'user=<bob> id=7',
      'EXTRACT-u = user=(<)?\\K(?<u>\\w+)(?(1)>)\nEXTRACT-id = \\bid=\\K(?<id>\\d+)',
    );
    expect(result.events[0]!.fields['u']).toBe('bob');
    expect(result.events[0]!.fields['id']).toBe('7');
  });

  it('a transform REGEX can recurse, to match balanced braces', () => {
    const { result } = run(
      'pre {"a":{"b":1}} post',
      'REPORT-j = json',
      '[json]\nREGEX = (?<doc>\\{(?:[^{}]|(?&doc))*\\})\n',
    );
    expect(result.events[0]!.fields['doc']).toBe('{"a":{"b":1}}');
  });

  it('`$` matches before a final newline, `\\z` does not', () => {
    // An empty capture after the newline leaves the newline in the first event.
    const props = ['LINE_BREAKER = \\n()(?=next)', 'EXTRACT-t = (?<t>\\w+)$', 'EXTRACT-z = (?<z>\\w+)\\z'];
    const { result } = run('tail\nnext', props.join('\n'));
    expect(result.events[0]!._raw).toBe('tail\n');
    expect(result.events[0]!.fields['t']).toBe('tail');
    expect(result.events[0]!.fields['z']).toBeUndefined();
  });

  it('an atomic group does not give back what it matched', () => {
    const { result } = run('aaab', 'EXTRACT-a = ^(?<a>(?>a+)ab)|^(?<b>a+b)');
    expect(result.events[0]!.fields['a']).toBeUndefined();
    expect(result.events[0]!.fields['b']).toBe('aaab');
  });
});
