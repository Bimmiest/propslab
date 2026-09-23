// ---------------------------------------------------------------------------
// evalCidrAndRegex.test.ts
// cidrmatch() was a stub that answered false for every address, and replace(),
// match() and mvfind() swallowed a pattern that would not compile (#291).
//
// Doc-derived: cidrmatch("X", Y) is documented as true when IP address Y is in
// the subnet X, for IPv4 and IPv6. No fidelity fixture covers eval, so these
// assertions are narrow — membership, family, and the malformed cases.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { applyEvalExpressions } from '../processors/evalProcessor';
import { runPipeline } from '../pipeline';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';

function event(fields: Record<string, string> = {}): SplunkEvent {
  return {
    _raw: 'raw',
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

const evalDir = (className: string, value: string): ConfDirective =>
  ({ key: `EVAL-${className}`, value, line: 3, directiveType: 'EVAL', className });

const cidr = (range: string, ip: string) =>
  applyEvalExpressions([event({ ip })], [evalDir('r', `cidrmatch("${range}", ip)`)])[0]!.fields['r'];

describe('cidrmatch() (#291)', () => {
  it.each([
    ['10.0.0.0/8', '10.1.2.3', 'true'],
    ['10.0.0.0/8', '11.0.0.1', 'false'],
    ['192.168.1.0/24', '192.168.1.255', 'true'],
    ['192.168.1.0/24', '192.168.2.0', 'false'],
    ['172.16.0.0/12', '172.31.255.255', 'true'],
    ['172.16.0.0/12', '172.32.0.0', 'false'],
    ['0.0.0.0/0', '8.8.8.8', 'true'],
    ['10.0.0.5/32', '10.0.0.5', 'true'],
    ['10.0.0.5', '10.0.0.5', 'true'],
    ['10.0.0.5', '10.0.0.6', 'false'],
    // The network bits beyond the prefix are not compared.
    ['10.1.2.3/8', '10.200.0.1', 'true'],
  ])('IPv4: cidrmatch("%s", %s) is %s', (range, ip, expected) => {
    expect(cidr(range, ip)).toBe(expected);
  });

  it.each([
    ['2001:db8::/32', '2001:db8:1234::1', 'true'],
    ['2001:db8::/32', '2001:db9::1', 'false'],
    ['fe80::/10', 'FE80::1', 'true'],
    ['fe80::/10', 'fec0::1', 'false'],
    ['::1/128', '::1', 'true'],
    ['::/0', '2001:db8::1', 'true'],
    ['::ffff:0:0/96', '::ffff:10.0.0.1', 'true'],
    ['2001:db8::/33', '2001:db8:8000::', 'false'],
    ['2001:db8:0:0:0:0:0:0/64', '2001:db8::abcd', 'true'],
  ])('IPv6: cidrmatch("%s", %s) is %s', (range, ip, expected) => {
    expect(cidr(range, ip)).toBe(expected);
  });

  it.each([
    ['10.0.0.0/8', 'not-an-ip'],
    ['10.0.0.0/8', '10.0.0.256'],
    ['10.0.0.0/8', '10.0.0'],
    ['10.0.0.0/33', '10.0.0.1'],
    ['10.0.0.0/x', '10.0.0.1'],
    ['garbage/8', '10.0.0.1'],
    ['2001:db8::/129', '2001:db8::1'],
    ['2001:db8::/32', '2001:db8:::1'],
    ['2001:db8::/32', '2001:db8::1%eth0'],
    ['1:2:3:4:5:6:7:8::/32', '1::'],
    // The families never match each other.
    ['10.0.0.0/8', '::ffff:10.0.0.1'],
    ['::ffff:0:0/96', '10.0.0.1'],
  ])('malformed or cross-family: cidrmatch("%s", %s) is false', (range, ip) => {
    expect(cidr(range, ip)).toBe('false');
  });

  it('answers false for an absent address, as the other predicates do', () => {
    const r = applyEvalExpressions([event()], [evalDir('r', 'cidrmatch("10.0.0.0/8", nope)')])[0]!;
    expect(r.fields['r']).toBe('false');
  });

  it('no longer warns that it is not simulated', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyEvalExpressions([event({ ip: '10.0.0.1' })], [evalDir('r', 'cidrmatch("10.0.0.0/8", ip)')], diagnostics);
    expect(diagnostics).toEqual([]);
  });
});

describe('eval regex arguments that do not compile (#291)', () => {
  const run = (expr: string, events = [event({ s: 'abc' })]) => {
    const diagnostics: ValidationDiagnostic[] = [];
    const out = applyEvalExpressions(events, [evalDir('r', expr)], diagnostics);
    return { out, diagnostics };
  };

  it('replace() warns, naming the class and pattern, and still returns its input', () => {
    const { out, diagnostics } = run('replace(s, "a(", "x")');
    expect(out[0]!.fields['r']).toBe('abc');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warning', directiveKey: 'EVAL-r', line: 3 });
    expect(diagnostics[0]?.message).toContain('EVAL-r');
    expect(diagnostics[0]?.message).toContain('"a("');
    expect(diagnostics[0]?.message).toContain('returned its input unchanged');
  });

  it('match() warns and says it evaluated to false', () => {
    const { out, diagnostics } = run('match(s, "[")');
    expect(out[0]!.fields['r']).toBe('false');
    expect(diagnostics[0]?.message).toContain('evaluated to false');
  });

  it('mvfind() warns too', () => {
    const { diagnostics } = run('mvfind(s, "(")');
    expect(diagnostics[0]?.message).toContain('mvfind()');
  });

  it('names the ReDoS guard when that is what refused the pattern', () => {
    const { diagnostics } = run('match(s, "(a+)+")');
    expect(diagnostics[0]?.message).toMatch(/ReDoS/);
  });

  it('warns once per class and pattern, not once per event', () => {
    const events = Array.from({ length: 20 }, () => event({ s: 'abc' }));
    const { diagnostics } = run('replace(s, "a(", "x")', events);
    expect(diagnostics).toHaveLength(1);
  });

  it('a pattern built from event data warns once for each distinct pattern', () => {
    const events = [event({ p: '(' }), event({ p: '(' }), event({ p: '[' })];
    const { diagnostics } = run('match("x", p)', events);
    expect(diagnostics).toHaveLength(2);
  });

  it('a valid pattern does not warn', () => {
    expect(run('replace(s, "a", "x")').diagnostics).toEqual([]);
  });

  it('INGEST_EVAL warns once across the batch, naming the field', () => {
    const meta = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
    const props = '[st]\nSHOULD_LINEMERGE = false\nTRANSFORMS-t = rw\n';
    const transforms = '[rw]\nINGEST_EVAL = out=replace(_raw, "(", "x")\n';
    const { diagnostics } = runPipeline('a\nb\nc\n', meta, props, transforms, { perEventPipeline: false });
    const hits = diagnostics.filter((d) => d.message.includes('replace() pattern'));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toContain('INGEST_EVAL out');
    expect(hits[0]?.file).toBe('transforms.conf');
  });
});
