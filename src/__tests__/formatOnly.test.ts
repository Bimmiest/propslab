import { describe, it, expect } from 'vitest';
import { isCommentOnly, isFormattingOnly } from '../../scripts/lib/formatOnly.mjs';

// mutation.yml skips a file whose change these call formatting or comments
// only, so a false "yes" would let a real change through unmutated.
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

describe('isCommentOnly', () => {
  const file = 'src/engine/example.ts';
  const code = 'export function f(a: number): number {\n  return a + 1;\n}\n';

  it('is true when only comments changed, of any kind', () => {
    expect(isCommentOnly(file, `// old\n${code}`, `// new, and longer\n${code}`)).toBe(true);
    expect(isCommentOnly(file, `/** Adds one. */\n${code}`, `/**\n * Adds one to a.\n */\n${code}`)).toBe(true);
    expect(isCommentOnly(file, code, code.replace('return', '/* inline */ return'))).toBe(true);
  });

  it('is true when comments and layout both changed', () => {
    const after = '// Adds one.\nexport function f(a:number):number{return a+1;}\n';
    expect(isCommentOnly(file, code, after)).toBe(true);
  });

  it('is false when code changed beside a comment', () => {
    expect(isCommentOnly(file, `// old\n${code}`, `// new\n${code.replace('+ 1', '+ 2')}`)).toBe(false);
  });

  it('is false when a type changed, although types do not run', () => {
    expect(isCommentOnly(file, code, code.replace('a: number)', 'a: bigint)'))).toBe(false);
  });

  it('is false when a Stryker directive was added, removed or edited', () => {
    const disabled = `// Stryker disable next-line all\n${code}`;
    expect(isCommentOnly(file, code, disabled)).toBe(false);
    expect(isCommentOnly(file, disabled, code)).toBe(false);
    expect(isCommentOnly(file, disabled, disabled.replace('all', 'ArithmeticOperator'))).toBe(false);
  });

  it('is not fooled by comment markers inside string, template and regex literals', () => {
    const before = "export const r = /https?:\\/\\//;\nexport const s = '/* x */';\nexport const t = `//${1}`;\n";
    expect(isCommentOnly(file, before, before.replace('`//${1}`', '`//${2}`'))).toBe(false);
    expect(isCommentOnly(file, before, before.replace("'/* x */'", "'/* y */'"))).toBe(false);
    expect(isCommentOnly(file, before, before.replace('https?', 'http'))).toBe(false);
  });

  it('is false for text that does not parse', () => {
    expect(isCommentOnly(file, 'export const x = 1;\n', 'export const x = ;\n')).toBe(false);
  });
});
