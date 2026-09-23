import { describe, it, expect } from 'vitest';
import { applyEvalExpressions } from '../processors/evalProcessor';
import type { ConfDirective, SplunkEvent, ValidationDiagnostic } from '../types';

const ev = (): SplunkEvent => ({
  _raw: 'x', _time: null, _meta: {}, fields: { n: '3.14159' },
  metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
  lineNumbers: { start: 1, end: 1 }, processingTrace: [],
});
const evalDir = (expr: string): ConfDirective =>
  ({ key: 'EVAL-out', value: expr, line: 1, directiveType: 'EVAL', className: 'out' });

function warningsFor(expr: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  applyEvalExpressions([ev()], [evalDir(expr)], diagnostics);
  return diagnostics;
}

// #127: sigfig() and exact() returned their argument unrounded with no warning —
// the only two unsimulated builtins that failed silently, and the two whose
// output most resembles a correct answer.
describe('eval — every unsimulated builtin warns (#127)', () => {
  it.each(['sigfig', 'exact'])('%s() warns', (fn) => {
    const diagnostics = warningsFor(`${fn}(n)`);
    expect(diagnostics.some((d) => d.message.startsWith(`${fn}() is not fully simulated`))).toBe(true);
  });

  it.each(['mvfilter', 'searchmatch', 'strptime', 'relative_time', 'md5', 'sha256'])(
    '%s() still warns',
    (fn) => {
      const diagnostics = warningsFor(`${fn}(n)`);
      expect(diagnostics.some((d) => d.message.startsWith(`${fn}() is not fully simulated`))).toBe(true);
    },
  );

  it('a fully simulated function does not warn', () => {
    expect(warningsFor('round(n, 2)')).toHaveLength(0);
    // Simulated since #291, so it left the stub list.
    expect(warningsFor('cidrmatch("10.0.0.0/8", "10.1.2.3")')).toHaveLength(0);
  });

  it('sigfig still returns a usable value alongside the warning', () => {
    const r = applyEvalExpressions([ev()], [evalDir('sigfig(n)')])[0]!;
    expect(r.fields.out).toBe('3.14159');
  });
});
