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
    expect(e.processingTrace).toEqual([]);
    expect(e.noOps?.map((n) => n.reason)).toEqual([{ kind: 'fields-already-set', fields: ['addr'] }]);
  });

  it('creates nothing when the source field is absent', () => {
    const e = applyFieldAliases([event({ other: 'x' })], [dir('a', 'ip AS ipaddress')], runCtx(FIXED_NOW))[0]!;
    expect(e.fields['ipaddress']).toBeUndefined();
    expect(e.processingTrace).toEqual([]);
    expect(e.noOps).toEqual([
      {
        directive: 'FIELDALIAS-a',
        file: 'props.conf',
        line: 1,
        phase: 'search-time',
        reason: { kind: 'source-key-empty', sourceKey: 'ip' },
      },
    ]);
  });
});

// Doc-derived (props.conf.spec, FIELDALIAS): with AS, "If the <orig_field_name>
// field has no value or does not exist, the <new_field_name> is removed"; with
// ASNEW, it "is kept". Until #445 a missing source left the target alone in
// both modes.
describe('applyFieldAliases — a source with no value (#445)', () => {
  const run = (fields: Record<string, string | string[]>, value: string) =>
    applyFieldAliases([event(fields)], [dir('a', value)], runCtx(FIXED_NOW))[0]!;

  it('AS removes the target when the source does not exist', () => {
    const e = run({ src: '1.2.3.4', action: 'allowed' }, 'src_ip AS src');
    expect(e.fields).toEqual({ action: 'allowed' });
  });

  it('ASNEW keeps the target when the source does not exist', () => {
    const e = run({ src: '1.2.3.4' }, 'src_ip ASNEW src');
    expect(e.fields).toEqual({ src: '1.2.3.4' });
    expect(e.processingTrace).toEqual([]);
  });

  it.each([
    ['an empty string', ''],
    ['a multivalue field with no values', []],
  ])('treats %s as no value', (_label, empty) => {
    expect(run({ src_ip: empty, src: '1.2.3.4' }, 'src_ip AS src').fields).toEqual({ src_ip: empty });
    expect(run({ src_ip: empty, src: '1.2.3.4' }, 'src_ip ASNEW src').fields).toEqual({
      src_ip: empty,
      src: '1.2.3.4',
    });
    // Nor is the empty value copied to a target that does not exist.
    expect(run({ src_ip: empty }, 'src_ip AS src').fields).toEqual({ src_ip: empty });
    expect(run({ src_ip: empty }, 'src_ip ASNEW src').fields).toEqual({ src_ip: empty });
  });

  it('copies a multivalue source that has values', () => {
    expect(run({ ips: ['a', 'b'] }, 'ips AS ip').fields['ip']).toEqual(['a', 'b']);
  });

  it('records the removal in the trace, not as a no-op', () => {
    const e = run({ src: '1.2.3.4' }, 'src_ip AS src');
    expect(e.processingTrace).toEqual([
      {
        processor: 'FIELDALIAS',
        phase: 'search-time',
        description: 'Removed src (src_ip has no value)',
        fieldsAdded: [],
        fieldsRemoved: ['src'],
        fieldAliases: [],
      },
    ]);
    expect(e.noOps).toBeUndefined();
  });

  it('describes a step that both created and removed fields', () => {
    const e = run({ a: '1', x: 'old', y: 'old' }, 'a AS b  a AS c  missing1 AS x  missing2 AS y');
    expect(e.fields).toEqual({ a: '1', b: '1', c: '1' });
    const [step] = e.processingTrace;
    expect(step?.description).toBe(
      'Created aliases: b (from a), c (from a); Removed x (missing1 has no value), y (missing2 has no value)',
    );
    expect(step?.fieldsAdded).toEqual(['b', 'c']);
    expect(step?.fieldsRemoved).toEqual(['x', 'y']);
    expect(step?.fieldAliases).toEqual([
      { target: 'b', source: 'a' },
      { target: 'c', source: 'a' },
    ]);
  });

  it('reports a target an earlier alias created and a later one removed as removed', () => {
    const e = run({ a: '1' }, 'a AS x  missing AS x');
    expect(e.fields).toEqual({ a: '1' });
    const [step] = e.processingTrace;
    expect(step?.fieldsAdded).toEqual([]);
    expect(step?.fieldAliases).toEqual([]);
    expect(step?.fieldsRemoved).toEqual(['x']);
  });

  it('reports a target removed and then aliased again as created', () => {
    const e = run({ a: '1', x: 'old' }, 'missing AS x  a AS x');
    expect(e.fields).toEqual({ a: '1', x: '1' });
    const [step] = e.processingTrace;
    expect(step?.description).toBe('Created aliases: x (from a)');
    expect(step?.fieldsAdded).toEqual(['x']);
    expect(step?.fieldsRemoved).toBeUndefined();
  });

  it('reports a target aliased twice once, from the alias that set it', () => {
    const e = run({ a: '1', b: '2' }, 'a AS x  b AS x');
    expect(e.fields['x']).toBe('2');
    expect(e.processingTrace[0]?.fieldAliases).toEqual([{ target: 'x', source: 'b' }]);
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

// The warnings about an alias that cannot work as written: each names what to
// write instead, and says it once rather than once per event or per repeat.
describe('applyFieldAliases — diagnostics', () => {
  const diagnose = (events: SplunkEvent[], value: string): ValidationDiagnostic[] => {
    const diags: ValidationDiagnostic[] = [];
    applyFieldAliases(events, [dir('a', value)], runCtx(FIXED_NOW, diags));
    return diags;
  };

  it('warns once for a wildcard pair, however often it is repeated', () => {
    expect(diagnose([event({ src_ip: '1' })], 'src_* AS dest_*  src_* AS dest_*')).toEqual([
      {
        level: 'warning',
        message:
          'FIELDALIAS does not support wildcards — "src_* AS dest_*" will not take effect on the search head. ' +
          'Use explicit "orig AS new" pairs, or rename at search time (| rename src_* AS dest_*).',
        file: 'props.conf',
        line: 1,
        directiveKey: 'FIELDALIAS-a',
      },
    ]);
  });

  it('warns about each wildcard pair, including one with a wildcard in the new name alone', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = applyFieldAliases(
      [event({ ip: '1' })],
      [dir('a', 'src_* AS dest  ip AS addr_*')],
      runCtx(FIXED_NOW, diags),
    )[0]!;
    expect(e.fields).toEqual({ ip: '1' });
    expect(diags.map((d) => d.message)).toEqual([
      expect.stringContaining('"src_* AS dest" will not take effect'),
      expect.stringContaining('"ip AS addr_*" will not take effect'),
    ]);
  });

  it('warns once about an unquoted dotted source used by several aliases', () => {
    expect(diagnose([event({ 'event.f': 'v' })], 'event.f AS x  event.f AS y')).toEqual([
      {
        level: 'warning',
        message:
          'FIELDALIAS-a: "event.f" contains characters that must be quoted to reference a field — ' +
          "single-quote it: 'event.f'.",
        file: 'props.conf',
        line: 1,
        directiveKey: 'FIELDALIAS-a',
        suggestion: "Use 'event.f' instead of event.f.",
      },
    ]);
  });

  // Index-time extractions strip a field name's leading underscores, so an
  // alias of `__GID` finds nothing while the event has `GID`.
  it('warns once when the source names a field whose leading underscores were stripped', () => {
    expect(diagnose([event({ GID: '100' }), event({ GID: '101' })], '__GID AS gid')).toEqual([
      {
        level: 'warning',
        message:
          'FIELDALIAS references "__GID", but index-time extractions strip leading underscores — ' +
          'Splunk will resolve this as "GID". Update the alias to use "GID".',
        file: 'props.conf',
        line: 1,
        directiveKey: 'FIELDALIAS-a',
        suggestion: 'Replace "__GID" with "GID"',
      },
    ]);
  });

  it.each([
    ['an internal field', { time: 'x' }, '_time AS t'],
    ['a stripped name the event does not have', { other: 'x' }, '_GID AS gid'],
    ['a source with no underscore to strip', { foo: '' }, 'foo AS bar'],
    ['a source that has a value', { _GID: '1', GID: '2' }, '_GID AS gid'],
  ])('does not warn about %s', (_label, fields, value) => {
    expect(diagnose([event(fields)], value)).toEqual([]);
  });
});
