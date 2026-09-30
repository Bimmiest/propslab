import { describe, expect, it } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { collectRegexSuspects } from '../suspects';

// A handle on V8's collector without starting vitest with --expose-gc.
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const heapUsedMb = () => {
  gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

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
