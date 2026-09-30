import { describe, it, expect } from 'vitest';
import { applyEvalExpressions } from '../processors/evalProcessor';
import type { ConfDirective, SplunkEvent, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

const ev = (): SplunkEvent => makeEvent('x', { fields: { n: '3.14159' } });
const evalDir = (expr: string): ConfDirective => ({
  key: 'EVAL-out',
  value: expr,
  line: 1,
  directiveType: 'EVAL',
  className: 'out',
});

function warningsFor(expr: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  applyEvalExpressions([ev()], [evalDir(expr)], runCtx(FIXED_NOW, diagnostics));
  return diagnostics;
}

// sigfig() and exact() return their argument unrounded, so they warn like every
// other unsimulated builtin: their output most resembles a correct answer.
describe('eval — every unsimulated builtin warns (#127)', () => {
  it.each(['sigfig', 'exact'])('%s() warns', (fn) => {
    const diagnostics = warningsFor(`${fn}(n)`);
    expect(diagnostics.some((d) => d.message.startsWith(`${fn}() is not fully simulated`))).toBe(true);
  });

  it.each(['mvfilter', 'searchmatch', 'strptime', 'relative_time', 'md5', 'sha256'])('%s() still warns', (fn) => {
    const diagnostics = warningsFor(`${fn}(n)`);
    expect(diagnostics.some((d) => d.message.startsWith(`${fn}() is not fully simulated`))).toBe(true);
  });

  it('a fully simulated function does not warn', () => {
    expect(warningsFor('round(n, 2)')).toHaveLength(0);
    // Simulated, so not on the stub list.
    expect(warningsFor('if(cidrmatch("10.0.0.0/8", "10.1.2.3"), 1, 0)')).toHaveLength(0);
  });

  it('sigfig still returns a usable value alongside the warning', () => {
    const r = applyEvalExpressions([ev()], [evalDir('sigfig(n)')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['out']).toBe('3.14159');
  });
});
