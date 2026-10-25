import { describe, it, expect } from 'vitest';
import { isCommentOnly } from '../../scripts/lib/formatOnly.mjs';

// mutation.yml skips a file whose change this calls formatting or comments
// only, so a false "yes" would let a real change through unmutated.
describe('isCommentOnly', () => {
  const file = 'src/engine/example.ts';
  const code = 'export function f(a: number): number {\n  return a + 1;\n}\n';

  it('is true when only comments changed, of any kind', () => {
    expect(isCommentOnly(file, `// old\n${code}`, `// new, and longer\n${code}`)).toBe(true);
    expect(isCommentOnly(file, `/** Adds one. */\n${code}`, `/**\n * Adds one to a.\n */\n${code}`)).toBe(true);
    expect(isCommentOnly(file, code, code.replace('return', '/* inline */ return'))).toBe(true);
  });

  it('is true when only layout changed, and false when a reformat adds a token (#571)', () => {
    const before = 'export function f(a: number, b: number) { return a + b; }\n';
    const after = 'export function f(a: number, b: number) {\n  return a + b;\n}\n';
    expect(isCommentOnly(file, before, after)).toBe(true);
    // Prettier adds the semicolon here. Both sides of a PR are Prettier's
    // output already, so this arises only when a Prettier upgrade changes it.
    expect(isCommentOnly(file, 'export const x = 1\n', 'export const x = 1;\n')).toBe(false);
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

  it('is false when a Stryker directive moved, its text unchanged (#571)', () => {
    const two = 'export const a = 1;\nexport const b = 2;\n';
    const onA = `// Stryker disable next-line all\n${two}`;
    const onB = two.replace('export const b', '// Stryker disable next-line all\nexport const b');
    expect(isCommentOnly(file, onA, onB)).toBe(false);
    // Text around it is still free to change.
    expect(isCommentOnly(file, onA, onA.replace('next-line all', 'next-line all\n// why'))).toBe(true);
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
