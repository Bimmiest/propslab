import { describe, it, expect } from 'vitest';
import { applyKvMode } from '../processors/kvMode';
import type { ConfDirective, SplunkEvent } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';
import { expectLinearWork } from '../../test/scanWork';

const ev = (raw: string): SplunkEvent => makeEvent(raw);
const kv = (mode: string): ConfDirective[] => [{ key: 'KV_MODE', value: mode, line: 1, directiveType: 'KV_MODE' }];

// Quoted values of either style are consumed whole, so no pass mines a
// key=value from inside a quoted value of the other style.
describe('KV_MODE auto — quoted passes do not mine inside each other (#123)', () => {
  it('does not extract a single-quoted pair from inside a double-quoted value', () => {
    const r = applyKvMode([ev(`msg="an x='inner' thing" a=1`)], kv('auto'), runCtx(FIXED_NOW))[0]!;
    expect(r.fields['msg']).toBe("an x='inner' thing");
    expect(r.fields['a']).toBe('1');
    expect(r.fields).not.toHaveProperty('x');
  });

  it('does not extract a double-quoted pair from inside a single-quoted value', () => {
    const r = applyKvMode([ev(`msg='an x="inner" thing' a=1`)], kv('auto'), runCtx(FIXED_NOW))[0]!;
    expect(r.fields['msg']).toBe('an x="inner" thing');
    expect(r.fields['a']).toBe('1');
    expect(r.fields).not.toHaveProperty('x');
  });

  it('still extracts genuine single-quoted pairs outside any quoted value', () => {
    const r = applyKvMode([ev(`user='alice' role="admin" id=7`)], kv('auto'), runCtx(FIXED_NOW))[0]!;
    expect(r.fields['user']).toBe('alice');
    expect(r.fields['role']).toBe('admin');
    expect(r.fields['id']).toBe('7');
  });

  it('still keeps the bare pass out of quoted values', () => {
    const r = applyKvMode([ev(`msg="error code=42" status=ok`)], kv('auto'), runCtx(FIXED_NOW))[0]!;
    expect(r.fields['msg']).toBe('error code=42');
    expect(r.fields['status']).toBe('ok');
    expect(r.fields).not.toHaveProperty('code');
  });

  it('auto_escaped still unescapes and still blocks nested mining', () => {
    const r = applyKvMode([ev(`msg="say \\"hi\\" x='inner'" a=1`)], kv('auto_escaped'), runCtx(FIXED_NOW))[0]!;
    expect(r.fields['msg']).toBe(`say "hi" x='inner'`);
    expect(r.fields['a']).toBe('1');
    expect(r.fields).not.toHaveProperty('x');
  });
});

describe('KV_MODE auto — long events (#427)', () => {
  it('blanks quoted spans in linear time', () => {
    // 32k quoted pairs, each hiding a bare pair, about 490 KB. Rebuilding the
    // blanked copy per pair took 7.5 s here. Counted, not timed (#507): the
    // length copied by slices and joins must not much more than double when
    // the number of pairs does.
    const eventOf = (pairs: number) =>
      Array.from({ length: pairs }, (_, i) => `k${i}="v x${i}=${i}"`).join(' ') + ' tail=end';
    expectLinearWork((pairs) => {
      const e = ev(eventOf(pairs));
      return () => void applyKvMode([e], kv('auto'), runCtx(FIXED_NOW));
    }, 4_000);
    const raw = eventOf(32_000);
    const r = applyKvMode([ev(raw)], kv('auto'), runCtx(FIXED_NOW))[0]!;
    expect(r.fields['k31999']).toBe('v x31999=31999');
    expect(r.fields['tail']).toBe('end');
    expect(r.fields).not.toHaveProperty('x5');
  });
});
