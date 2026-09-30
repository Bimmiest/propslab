import { describe, it, expect } from 'vitest';
import { isFormattingOnly } from '../../scripts/lib/formatOnly.mjs';

// mutation.yml skips a file whose change this calls formatting only, so a
// false "yes" would let a real change through unmutated.
describe('isFormattingOnly', () => {
  const file = 'src/engine/example.ts';

  it('is true when only layout changed', async () => {
    const before = 'export function f(a:number,b:number){return a+b}\n';
    const after = 'export function f(a: number, b: number) {\n  return a + b;\n}\n';
    expect(await isFormattingOnly(file, before, after)).toBe(true);
  });

  it('is false when behaviour changed, however small', async () => {
    const before = 'export const f = (a: number) => a + 1;\n';
    expect(await isFormattingOnly(file, before, 'export const f = (a: number) => a - 1;\n')).toBe(false);
    expect(await isFormattingOnly(file, before, "export const f = (a: number) => a + '1';\n")).toBe(false);
  });

  it('is false when a comment changed', async () => {
    expect(await isFormattingOnly(file, '// a\nexport const x = 1;\n', '// b\nexport const x = 1;\n')).toBe(false);
  });

  it('is false for text that does not parse', async () => {
    expect(await isFormattingOnly(file, 'export const x = 1;\n', 'export const x = ;\n')).toBe(false);
  });
});
