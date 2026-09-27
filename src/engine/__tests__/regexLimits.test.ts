// ---------------------------------------------------------------------------
// regexLimits.test.ts
// MATCH_LIMIT and DEPTH_LIMIT, simulated since patterns run on PCRE2 (#368).
//
// Doc-derived (props.conf.spec / transforms.conf.spec): both bound how hard
// PCRE tries — MATCH_LIMIT the calls to its internal match(), DEPTH_LIMIT how
// deeply backtracking nests — defaulting to 100000 and 1000. EXTRACT reads
// them from its props.conf stanza, REPORT and TRANSFORMS from the transform's
// own stanza, and a match that reaches one fails. PCRE2 counts depth in heap
// frames rather than PCRE1's stack recursion, so the exact depth at which a
// pattern stops is approximate; the subjects below sit far from the boundary.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { extractFields } from '../processors/fieldExtractor';
import { runPipeline } from '../pipeline';
import { describeNoOp } from '../noOpExplainer';
import type { ConfDirective, EventMetadata, SplunkEvent } from '../types';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function event(raw: string): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: META,
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

const extract = (value: string): ConfDirective => ({
  key: 'EXTRACT-v',
  value,
  line: 2,
  directiveType: 'EXTRACT',
  className: 'v',
});
const setting = (key: string, value: string): ConfDirective => ({ key, value, line: 3, directiveType: key });

// Every iteration of the group is a backtracking point PCRE keeps, so the
// depth grows with the subject: about 1200 here, past the default of 1000.
const DEEP = 'ab'.repeat(600);
const ALTERNATING = '^(?<v>(?:a|b)*)$';

describe('EXTRACT under MATCH_LIMIT and DEPTH_LIMIT', () => {
  it('fails a match that nests past the default DEPTH_LIMIT, and says why', () => {
    const [e] = extractFields([event(DEEP)], [extract(ALTERNATING)]);
    expect(e!.fields['v']).toBeUndefined();
    const reason = e!.noOps?.[0]?.reason;
    expect(reason?.kind).toBe('regex-limit');
    expect(describeNoOp(reason!)).toMatch(/depth limit.*MATCH_LIMIT \/ DEPTH_LIMIT/);
  });

  it('lets the same match through with a higher DEPTH_LIMIT', () => {
    const [e] = extractFields([event(DEEP)], [extract(ALTERNATING), setting('DEPTH_LIMIT', '5000')]);
    expect(e!.fields['v']).toBe(DEEP);
  });

  it('fails a match past MATCH_LIMIT even when depth is unlimited', () => {
    const long = 'ab'.repeat(60000);
    const unlimitedDepth = setting('DEPTH_LIMIT', '0');
    const [limited] = extractFields([event(long)], [extract(ALTERNATING), unlimitedDepth]);
    const reason = limited!.noOps?.[0]?.reason;
    expect(reason?.kind).toBe('regex-limit');
    expect(reason?.kind === 'regex-limit' ? reason.error : '').toMatch(/match limit/);
    const [raised] = extractFields(
      [event(long)],
      [extract(ALTERNATING), unlimitedDepth, setting('MATCH_LIMIT', '10000000')],
    );
    expect(raised!.fields['v']).toBe(long);
  });

  it('leaves an ordinary extraction alone at the defaults', () => {
    const [e] = extractFields([event('user=admin')], [extract('user=(?<v>\\w+)')]);
    expect(e!.fields['v']).toBe('admin');
  });
});

describe('transforms.conf REGEX under its own stanza\'s limits', () => {
  const props = '[st]\nREPORT-v = deep\n';

  it('fails at the default DEPTH_LIMIT and succeeds with a higher one', () => {
    const at = (transforms: string) => runPipeline(DEEP, META, props, transforms).result.events[0]!;
    const stopped = at(`[deep]\nREGEX = ${ALTERNATING}\n`);
    expect(stopped.fields['v']).toBeUndefined();
    expect(stopped.noOps?.some((n) => n.reason.kind === 'regex-limit')).toBe(true);

    const raised = at(`[deep]\nREGEX = ${ALTERNATING}\nDEPTH_LIMIT = 5000\n`);
    expect(raised.fields['v']).toBe(DEEP);
  });

  it('does not take the limits from the props.conf stanza', () => {
    const e = runPipeline(DEEP, META, `${props}DEPTH_LIMIT = 5000\n`, `[deep]\nREGEX = ${ALTERNATING}\n`).result
      .events[0]!;
    expect(e.fields['v']).toBeUndefined();
  });
});
