import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { boundedRegexSuspects, collectRegexSuspects } from '../suspects';
import { MAX_PAYLOAD_BYTES, responseBytes } from '../responseBudget';

// A handle on V8's collector without starting vitest with --expose-gc.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const heapUsedMb = () => {
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

describe('boundedRegexSuspects (#468)', () => {
  it('passes a list that fits through whole, flagged first', () => {
    const props = '[st]\nEXTRACT-a = (?<a>\\w+)\nEXTRACT-b = (?<b>(x+)+y)';
    const { suspects, total } = boundedRegexSuspects(props, '[t]\nREGEX = (z)');
    expect(total).toBe(3);
    expect(suspects.map((s) => s.key)).toEqual(['EXTRACT-b', 'EXTRACT-a', 'REGEX']);
  });

  it('cuts a list that would not fit in a response, keeping its length', () => {
    // 200 patterns of 50,000 characters: some 20 MB of suspects in both copies.
    const props = ['[st]', ...Array.from({ length: 200 }, (_, i) => `EXTRACT-${i} = ${'a'.repeat(50_000)}`)];
    const { suspects, total } = boundedRegexSuspects(props.join('\n'), '');
    expect(total).toBe(200);
    expect(suspects.length).toBeGreaterThan(0);
    expect(suspects.length).toBeLessThan(200);
    expect(responseBytes({ regex_directives: suspects })).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });
});

describe('the ReDoS verdict cache (#487)', () => {
  it("keeps no caller's conf alive through its keys", () => {
    // Each conf is about 4 MB (two-byte text) around two short patterns. A
    // key cut from it by slicing and trimming is a view of the whole conf,
    // so 60 of them cached held some 240 MB after the confs were dropped.
    const before = heapUsedMb();
    for (let i = 0; i < 60; i++) {
      const conf = [
        `# ${'日'.repeat(2_000_000)}`,
        '[st]',
        `EXTRACT-a = (?<a>alpha_${i}_[a-z]+)`,
        `EXTRACT-b = (?<b>(beta_${i})+x)`,
      ].join('\n');
      expect(collectRegexSuspects(conf, '')).toHaveLength(2);
    }
    expect(heapUsedMb() - before).toBeLessThan(50);
  }, 60_000);
});
