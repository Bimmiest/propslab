// ---------------------------------------------------------------------------
// kvModeMaxchars.test.ts
// limits.conf's `[kv] maxchars` cap on automatic key=value extraction (#451).
//
// Doc-derived (limits.conf.spec, [kv] maxchars): "When non-zero, truncate _raw
// to this size and then do auto KV", default 10240 characters. The simulator
// reads no limits.conf, so the default always applies. That KV_MODE = json is
// not capped at `[spath] extraction_cutoff` comes from #451.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { applyKvMode } from '../processors/kvMode';
import { runPipeline } from '../pipeline';
import type { ConfDirective, SplunkEvent, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

const CAP = 10_240;
const HEAD = 'early=yes pad=';
const LONG = `${HEAD}${'x'.repeat(11_000)} late=yes`;

function dir(value: string): ConfDirective {
  return { key: 'KV_MODE', value, line: 1, directiveType: 'KV_MODE' };
}

function kv(raws: string[], mode = 'auto', diags: ValidationDiagnostic[] = []): SplunkEvent[] {
  return applyKvMode(
    raws.map((raw, i) => makeEvent(raw, { lineNumbers: { start: i + 1, end: i + 1 } })),
    [dir(mode)],
    runCtx(FIXED_NOW, diags),
  );
}

const capInfo = (diags: ValidationDiagnostic[]) => diags.filter((d) => d.message.includes('[kv] maxchars'));

describe('KV_MODE = auto reads only the first 10240 characters of _raw', () => {
  it('does not extract a pair that starts after the cap, and cuts a value that runs across it', () => {
    const [e] = kv([LONG]);
    expect(e?.fields['early']).toBe('yes');
    expect(e?.fields['pad']).toBe('x'.repeat(CAP - HEAD.length));
    expect(e?.fields['late']).toBeUndefined();
  });

  it('extracts every pair from a short event', () => {
    const diags: ValidationDiagnostic[] = [];
    const [e] = kv(['early=yes pad=x late=yes'], 'auto', diags);
    expect(e?.fields).toMatchObject({ early: 'yes', pad: 'x', late: 'yes' });
    expect(e?.processingTrace.at(-1)?.description).toBe('Extracted 3 fields via KV_MODE=auto');
    expect(capInfo(diags)).toEqual([]);
  });

  it('applies to auto_escaped too', () => {
    const [e] = kv([LONG], 'auto_escaped');
    expect(e?.fields['early']).toBe('yes');
    expect(e?.fields['late']).toBeUndefined();
  });

  it('reads an event of exactly 10240 characters whole', () => {
    const raw = `a=1 ${'x'.repeat(CAP - 8)} z=9`;
    expect(raw).toHaveLength(CAP);
    const diags: ValidationDiagnostic[] = [];
    const [e] = kv([raw], 'auto', diags);
    expect(e?.fields).toMatchObject({ a: '1', z: '9' });
    expect(e?.processingTrace.at(-1)?.description).toBe('Extracted 2 fields via KV_MODE=auto');
    expect(capInfo(diags)).toEqual([]);
  });

  it('keeps the part of a value inside the cap without calling the field lost', () => {
    const raw = `a=1 ${'x'.repeat(CAP - 8)} z=99`;
    const diags: ValidationDiagnostic[] = [];
    const [e] = kv([raw], 'auto', diags);
    expect(e?.fields['z']).toBe('9');
    expect(e?.processingTrace.at(-1)?.description).toBe('Extracted 2 fields via KV_MODE=auto');
    expect(capInfo(diags)).toEqual([]);
  });

  it('names the fields it did not extract in the trace', () => {
    const [e] = kv([`${LONG} later=1`]);
    expect(e?.processingTrace.at(-1)).toMatchObject({
      processor: 'KV_MODE(auto)',
      description:
        'Extracted 2 fields via KV_MODE=auto; not extracted after character 10240 (limits.conf [kv] maxchars): late, later',
      fieldsAdded: ['early', 'pad'],
    });
  });

  it('records the cut even when nothing before it was extracted', () => {
    const raw = `${'x'.repeat(CAP)} late=yes`;
    const [e] = kv([raw]);
    expect(e?.fields).toEqual({});
    expect(e?.processingTrace.at(-1)?.description).toBe(
      'Extracted 0 fields via KV_MODE=auto; not extracted after character 10240 (limits.conf [kv] maxchars): late',
    );
  });

  it('names ten of them and counts the rest', () => {
    const past = (n: number) => Array.from({ length: n }, (_, i) => `p${i}=1`).join(' ');
    const description = (n: number) => kv([`${LONG} ${past(n)}`])[0]?.processingTrace.at(-1)?.description;
    expect(description(12)).toMatch(/maxchars\): late, p0, p1, p2, p3, p4, p5, p6, p7, p8 and 3 more$/);
    expect(description(9)).toMatch(/maxchars\): late, p0, p1, p2, p3, p4, p5, p6, p7, p8$/);
  });

  it('does not name a field already extracted before the cap', () => {
    const [e] = kv([`${LONG} early=no`]);
    expect(e?.fields['early']).toBe('yes');
    expect(e?.processingTrace.at(-1)?.description).toMatch(/maxchars\): late$/);
  });

  it('reports it once per run, at the first event it cut, as information', () => {
    const diags: ValidationDiagnostic[] = [];
    kv(['short=1', LONG, LONG], 'auto', diags);
    const info = capInfo(diags);
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ level: 'info', file: 'raw', line: 2 });
    expect(info[0]?.message).toBe(
      'KV_MODE = auto: automatic key=value extraction reads only the first 10240 characters of an event ' +
        '(limits.conf [kv] maxchars), so pairs after that are not extracted (here: late). The simulator applies ' +
        'that default and cannot change it; in Splunk, raising maxchars extracts them.',
    );
  });

  // The simulator's choice, not a documented one: the cap is applied to the
  // key=value pass only, which finds nothing in JSON for it to cost, so a long
  // JSON event under auto is neither cut nor reported.
  it('does not report the cap for a JSON event, whose JSON pass it leaves whole', () => {
    const diags: ValidationDiagnostic[] = [];
    const [e] = kv([`{"early":"yes","pad":"${'x'.repeat(11_000)}","late":"yes"}`], 'auto', diags);
    expect(e?.fields['late']).toBe('yes');
    expect(capInfo(diags)).toEqual([]);
  });
});

describe('the cap through the pipeline', () => {
  const run = (raw: string, props: string) =>
    runPipeline(raw, { index: 'main', host: 'h', source: 's', sourcetype: 'st' }, `[st]\n${props}`, '', {
      perEventPipeline: false,
      captureOffsets: false,
      now: FIXED_NOW,
    });

  it('leaves out the pair past it in a long event, and not in a short one', () => {
    const { result, diagnostics } = run(
      `${LONG}\nearly=yes pad=x late=yes\n`,
      'SHOULD_LINEMERGE = false\nKV_MODE = auto\nTRUNCATE = 0\nDATETIME_CONFIG = CURRENT\n',
    );
    const [long, short] = result.events;
    expect(long?.fields['early']).toBe('yes');
    expect(long?.fields['pad']).toBe('x'.repeat(CAP - HEAD.length));
    expect(long?.fields['late']).toBeUndefined();
    expect(short?.fields).toMatchObject({ early: 'yes', pad: 'x', late: 'yes' });
    expect(capInfo(diagnostics)).toHaveLength(1);
  });

  // #451: KV_MODE = json is not capped at [spath] extraction_cutoff (5000).
  it('does not stop KV_MODE = json at 5000 characters', () => {
    const raw = `{"early":"yes","pad":"${'x'.repeat(6_000)}","late":"yes"}`;
    expect(raw.indexOf('"late"')).toBeGreaterThan(5_000);
    const { result, diagnostics } = run(
      `${raw}\n`,
      'SHOULD_LINEMERGE = false\nKV_MODE = json\nTRUNCATE = 0\nDATETIME_CONFIG = CURRENT\n',
    );
    expect(result.events[0]?.fields).toMatchObject({ early: 'yes', late: 'yes' });
    expect(capInfo(diagnostics)).toEqual([]);
  });
});
