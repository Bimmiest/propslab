import { describe, it, expect } from 'vitest';
import { applyFieldAliases } from '../processors/fieldAlias';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

function event(fields: Record<string, string | string[]>): SplunkEvent {
  return makeEvent('raw', { fields });
}

function dir(className: string, value: string): ConfDirective {
  return { key: `FIELDALIAS-${className}`, value, line: 1, directiveType: 'FIELDALIAS', className };
}

describe('applyFieldAliases — literal', () => {
  it('creates an alias and keeps the original field', () => {
    const e = applyFieldAliases([event({ ip: '10.0.0.1' })], [dir('a', 'ip AS ipaddress')], runCtx(FIXED_NOW))[0]!;
    expect(e.fields['ipaddress']).toBe('10.0.0.1');
    expect(e.fields['ip']).toBe('10.0.0.1');
  });

  it('ASNEW does not overwrite an existing target', () => {
    const e = applyFieldAliases(
      [event({ ip: '10.0.0.1', addr: 'keep' })],
      [dir('a', 'ip ASNEW addr')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(e.fields['addr']).toBe('keep');
  });

  it('does nothing when the source field is absent', () => {
    const e = applyFieldAliases([event({ other: 'x' })], [dir('a', 'ip AS ipaddress')], runCtx(FIXED_NOW))[0]!;
    expect(e.fields['ipaddress']).toBeUndefined();
  });
});

describe('applyFieldAliases — wildcards are not supported (Splunk parity)', () => {
  // Splunk FIELDALIAS has no wildcard support (unlike the search-time `rename`
  // command). The tool must not simulate it; it warns and creates nothing.
  it('does NOT create wildcard aliases and warns instead', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = applyFieldAliases(
      [event({ src_ip: '10.0.0.1', src_port: '443' })],
      [dir('w', 'src_* AS dest_*')],
      runCtx(FIXED_NOW, diags),
    )[0]!;
    expect(e.fields['dest_ip']).toBeUndefined();
    expect(e.fields['dest_port']).toBeUndefined();
    expect(e.fields['src_ip']).toBe('10.0.0.1'); // originals untouched
    expect(diags.some((d) => d.message.includes('does not support wildcards'))).toBe(true);
  });

  it('warns for a prefix-strip wildcard (event.* AS *) and creates nothing', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = applyFieldAliases(
      [event({ 'event.field1': 'A', 'event.field2': 'B' })],
      [dir('w', 'event.* AS *')],
      runCtx(FIXED_NOW, diags),
    )[0]!;
    expect(e.fields['field1']).toBeUndefined();
    expect(e.fields['field2']).toBeUndefined();
    expect(diags.some((d) => d.message.includes('does not support wildcards'))).toBe(true);
  });
});

describe('applyFieldAliases — dotted (nested JSON) field names', () => {
  it('resolves a single-quoted dotted source field', () => {
    const e = applyFieldAliases(
      [event({ 'event.field': 'V' })],
      [dir('a', "'event.field' AS myfield")],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(e.fields['myfield']).toBe('V');
  });

  it('warns when an unquoted dotted source name is used', () => {
    const diags: ValidationDiagnostic[] = [];
    applyFieldAliases([event({ 'event.field': 'V' })], [dir('a', 'event.field AS myfield')], runCtx(FIXED_NOW, diags));
    const warn = diags.find((d) => d.message.includes('event.field'));
    expect(warn).toBeDefined();
    expect(warn!.level).toBe('warning');
    expect(warn!.suggestion).toBe("Use 'event.field' instead of event.field.");
  });

  it('does not warn for a plain unquoted source with no special characters', () => {
    const diags: ValidationDiagnostic[] = [];
    applyFieldAliases([event({ ip: '1' })], [dir('a', 'ip AS addr')], runCtx(FIXED_NOW, diags));
    expect(diags).toHaveLength(0);
  });
});
