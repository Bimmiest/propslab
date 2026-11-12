// ---------------------------------------------------------------------------
// regexLimits.test.ts
// MATCH_LIMIT and DEPTH_LIMIT, simulated because patterns run on PCRE2.
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
import { runCtx, FIXED_NOW, AT_FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function event(raw: string): SplunkEvent {
  return makeEvent(raw);
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
    const [e] = extractFields([event(DEEP)], [extract(ALTERNATING)], runCtx(FIXED_NOW));
    expect(e!.fields['v']).toBeUndefined();
    const reason = e!.noOps?.[0]?.reason;
    expect(reason?.kind).toBe('regex-limit');
    expect(describeNoOp(reason!)).toMatch(/depth limit.*MATCH_LIMIT \/ DEPTH_LIMIT/);
  });

  it('lets the same match through with a higher DEPTH_LIMIT', () => {
    const [e] = extractFields([event(DEEP)], [extract(ALTERNATING), setting('DEPTH_LIMIT', '5000')], runCtx(FIXED_NOW));
    expect(e!.fields['v']).toBe(DEEP);
  });

  it('fails a match past MATCH_LIMIT even when depth is unlimited', () => {
    const long = 'ab'.repeat(60000);
    const unlimitedDepth = setting('DEPTH_LIMIT', '0');
    const [limited] = extractFields([event(long)], [extract(ALTERNATING), unlimitedDepth], runCtx(FIXED_NOW));
    const reason = limited!.noOps?.[0]?.reason;
    expect(reason?.kind).toBe('regex-limit');
    expect(reason?.kind === 'regex-limit' ? reason.error : '').toMatch(/match limit/);
    const [raised] = extractFields(
      [event(long)],
      [extract(ALTERNATING), unlimitedDepth, setting('MATCH_LIMIT', '10000000')],
      runCtx(FIXED_NOW),
    );
    expect(raised!.fields['v']).toBe(long);
  });

  it('leaves an ordinary extraction alone at the defaults', () => {
    const [e] = extractFields([event('user=admin')], [extract('user=(?<v>\\w+)')], runCtx(FIXED_NOW));
    expect(e!.fields['v']).toBe('admin');
  });
});

describe("transforms.conf REGEX under its own stanza's limits", () => {
  const props = '[st]\nREPORT-v = deep\n';

  it('fails at the default DEPTH_LIMIT and succeeds with a higher one', () => {
    const at = (transforms: string) => runPipeline(DEEP, META, props, transforms, AT_FIXED_NOW).result.events[0]!;
    const stopped = at(`[deep]\nREGEX = ${ALTERNATING}\n`);
    expect(stopped.fields['v']).toBeUndefined();
    expect(stopped.noOps?.some((n) => n.reason.kind === 'regex-limit')).toBe(true);

    const raised = at(`[deep]\nREGEX = ${ALTERNATING}\nDEPTH_LIMIT = 5000\n`);
    expect(raised.fields['v']).toBe(DEEP);
  });

  it('fails past the default MATCH_LIMIT and succeeds with a higher one', () => {
    // DEPTH_LIMIT = 0 leaves depth unlimited, so it is MATCH_LIMIT alone that
    // stops the first run. TRUNCATE = 0 keeps the long subject whole.
    const long = 'ab'.repeat(60000);
    const at = (transforms: string) =>
      runPipeline(long, META, `${props}TRUNCATE = 0\n`, transforms, AT_FIXED_NOW).result.events[0]!;
    const stopped = at(`[deep]\nREGEX = ${ALTERNATING}\nDEPTH_LIMIT = 0\n`);
    expect(stopped.fields['v']).toBeUndefined();
    expect(stopped.noOps?.some((n) => n.reason.kind === 'regex-limit')).toBe(true);

    const raised = at(`[deep]\nREGEX = ${ALTERNATING}\nDEPTH_LIMIT = 0\nMATCH_LIMIT = 10000000\n`);
    expect(raised.fields['v']).toBe(long);
  });

  it('does not take the limits from the props.conf stanza', () => {
    const e = runPipeline(DEEP, META, `${props}DEPTH_LIMIT = 5000\n`, `[deep]\nREGEX = ${ALTERNATING}\n`, AT_FIXED_NOW)
      .result.events[0]!;
    expect(e.fields['v']).toBeUndefined();
  });
});

describe('#874 — a scan for every match that stops at a limit after the first match', () => {
  // `x` matches at once; at the run of a's, `(?:a+)+b` tries about 2^n ways
  // before it fails, which passes both Splunk's default MATCH_LIMIT and PCRE2's
  // own. So the scan finds the first two x's, stops, and never reaches the last.
  const STOPS = 'x|(?:a+)+b';
  const FIELD = 'x(?<v>\\d)|(?:a+)+b';
  const subject = (as: number) => `x1 x2 ${'a'.repeat(as)} x3`;
  const LONG = subject(30);
  const SHORT = subject(12);
  const run = (raw: string, props: string, transforms = '') => runPipeline(raw, META, props, transforms, AT_FIXED_NOW);
  const warningsAbout = (diagnostics: { message: string }[], text: string) =>
    diagnostics.filter((d) => d.message.includes(text)).map((d) => d.message);

  it('SEDCMD: replaces the matches before the limit, and warns that the rest is not masked', () => {
    const props = `[st]\nSEDCMD-mask = s/${STOPS}/X/g\n`;
    const { result, diagnostics } = run(LONG, props);
    expect(result.events[0]!._raw).toBe(`X1 X2 ${'a'.repeat(30)} x3`);
    const [warning] = warningsAbout(diagnostics, 'regex limit');
    expect(warning).toMatch(/^SEDCMD-mask: the scan for each match stopped at a regex limit \(.*limit.*\)/);
    expect(warning).toContain('the substitution is incomplete');
    expect(diagnostics.find((d) => d.message === warning)).toMatchObject({
      file: 'props.conf',
      line: 2,
      directiveKey: 'SEDCMD-mask',
    });

    const whole = run(SHORT, props);
    expect(whole.result.events[0]!._raw).toBe(`X1 X2 ${'a'.repeat(12)} X3`);
    expect(warningsAbout(whole.diagnostics, 'regex limit')).toEqual([]);
  });

  it('SEDCMD: a limit before any match stays a no-op, not a partial rewrite', () => {
    const { result, diagnostics } = run(`${'a'.repeat(30)} x`, `[st]\nSEDCMD-mask = s/${STOPS}/X/g\n`);
    expect(result.events[0]!._raw).toBe(`${'a'.repeat(30)} x`);
    expect(result.events[0]!.noOps?.[0]?.reason.kind).toBe('regex-limit');
    expect(warningsAbout(diagnostics, 'substitution is incomplete')).toEqual([]);
  });

  it('REPORT with FORMAT: keeps the values before the limit, and warns at the REGEX', () => {
    const transforms = `[t]\nREGEX = ${FIELD}\nFORMAT = v::$1\nMV_ADD = true\n`;
    const { result, diagnostics } = run(LONG, '[st]\nREPORT-v = t\n', transforms);
    expect(result.events[0]!.fields['v']).toEqual(['1', '2']);
    const [warning] = warningsAbout(diagnostics, 'regex limit');
    expect(warning).toMatch(/^Transform "t" stopped at a regex limit \(.*\).*incomplete/);
    expect(diagnostics.find((d) => d.message === warning)).toMatchObject({ file: 'transforms.conf', line: 2 });

    const whole = run(SHORT, '[st]\nREPORT-v = t\n', transforms);
    expect(whole.result.events[0]!.fields['v']).toEqual(['1', '2', '3']);
    expect(warningsAbout(whole.diagnostics, 'regex limit')).toEqual([]);
  });

  it('REPORT with named groups: keeps the values before the limit, and warns', () => {
    const transforms = `[t]\nREGEX = ${FIELD}\nMV_ADD = true\n`;
    const { result, diagnostics } = run(LONG, '[st]\nREPORT-v = t\n', transforms);
    expect(result.events[0]!.fields['v']).toEqual(['1', '2']);
    expect(warningsAbout(diagnostics, 'Transform "t" stopped at a regex limit')).toHaveLength(1);
  });

  it('TRANSFORMS with REPEAT_MATCH into DEST_KEY: writes the values before the limit, and warns', () => {
    const transforms = `[t]\nREGEX = ${FIELD}\nFORMAT = v::$1\nREPEAT_MATCH = true\nDEST_KEY = _meta\nWRITE_META = true\n`;
    const { result, diagnostics } = run(LONG, '[st]\nTRANSFORMS-v = t\n', transforms);
    expect(result.events[0]!._meta['v']).toEqual(['1', '2']);
    expect(warningsAbout(diagnostics, 'Transform "t" stopped at a regex limit')).toHaveLength(1);

    const whole = run(SHORT, '[st]\nTRANSFORMS-v = t\n', transforms);
    expect(whole.result.events[0]!._meta['v']).toEqual(['1', '2', '3']);
    expect(warningsAbout(whole.diagnostics, 'regex limit')).toEqual([]);
  });

  it('EVAL replace(): returns the partial rewrite, and warns naming the EVAL', () => {
    const props = `[st]\nEVAL-masked = replace(_raw, "${STOPS}", "X")\n`;
    const { result, diagnostics } = run(LONG, props);
    expect(result.events[0]!.fields['masked']).toBe(`X1 X2 ${'a'.repeat(30)} x3`);
    const [warning] = warningsAbout(diagnostics, 'regex limit');
    expect(warning).toMatch(/^EVAL-masked: replace\(\) pattern "x\|\(\?:a\+\)\+b" stopped at a regex limit \(.*\)/);
    expect(warning).toContain('only the matches before the limit were replaced');
    expect(diagnostics.find((d) => d.message === warning)).toMatchObject({ line: 2, directiveKey: 'EVAL-masked' });

    const whole = run(SHORT, props);
    expect(whole.result.events[0]!.fields['masked']).toBe(`X1 X2 ${'a'.repeat(12)} X3`);
    expect(warningsAbout(whole.diagnostics, 'regex limit')).toEqual([]);
  });

  it('warns once per directive in a run, not once per event', () => {
    const props =
      `[st]\nSHOULD_LINEMERGE = false\nSEDCMD-mask = s/${STOPS}/X/g\n` +
      `EVAL-masked = replace(_raw, "${STOPS}", "X")\nREPORT-v = t\n`;
    // SEDCMD runs first and turns the x's into X's.
    const transforms = `[t]\nREGEX = (?i)${FIELD}\nMV_ADD = true\n`;
    const { result, diagnostics } = run(`${LONG}\n${LONG}`, props, transforms);
    expect(result.events).toHaveLength(2);
    expect(warningsAbout(diagnostics, 'regex limit').map((m) => m.split(':')[0])).toEqual([
      'SEDCMD-mask',
      expect.stringMatching(/^Transform "t" stopped/),
      'EVAL-masked',
    ]);
  });

  it('INGEST_EVAL and STOP_PROCESSING_IF replace(): warn naming the directive', () => {
    const transforms =
      `[mask]\nINGEST_EVAL = _raw=replace(_raw, "${STOPS}", "X")\n` +
      `[stop]\nSTOP_PROCESSING_IF = replace(_raw, "${STOPS}", "") == ""\n`;
    const { result, diagnostics } = run(LONG, '[st]\nTRANSFORMS-a = mask, stop\n', transforms);
    expect(result.events[0]!._raw).toBe(`X1 X2 ${'a'.repeat(30)} x3`);
    const warnings = warningsAbout(diagnostics, 'stopped at a regex limit');
    expect(warnings.some((m) => m.startsWith('INGEST_EVAL _raw: replace() pattern'))).toBe(true);
    expect(warnings.some((m) => m.startsWith('STOP_PROCESSING_IF: replace() pattern'))).toBe(true);
  });
});
