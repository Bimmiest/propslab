import { describe, it, expect } from 'vitest';
import { isQuotedFieldName, unquoteFieldName, fieldNameNeedsQuoting, fieldQuotingWarning } from '../fieldRef';
import type { ConfDirective } from '../../types';

describe('fieldRef', () => {
  it('detects matched single/double quotes', () => {
    expect(isQuotedFieldName("'event.field'")).toBe(true);
    expect(isQuotedFieldName('"event.field"')).toBe(true);
    expect(isQuotedFieldName('event.field')).toBe(false);
    expect(isQuotedFieldName('\'mismatched"')).toBe(false);
    expect(isQuotedFieldName("'")).toBe(false);
  });

  it('strips one layer of matched quotes only', () => {
    expect(unquoteFieldName("'event.field'")).toBe('event.field');
    expect(unquoteFieldName('"a b"')).toBe('a b');
    expect(unquoteFieldName('event.field')).toBe('event.field');
    expect(unquoteFieldName("  'x' ")).toBe('x');
  });

  it('flags names with characters outside [A-Za-z0-9_]', () => {
    expect(fieldNameNeedsQuoting('event.field')).toBe(true);
    expect(fieldNameNeedsQuoting('x-1')).toBe(true);
    expect(fieldNameNeedsQuoting('plain_name1')).toBe(false);
    // wildcard handling
    expect(fieldNameNeedsQuoting('src_*', { allowWildcard: true })).toBe(false);
    expect(fieldNameNeedsQuoting('event.*', { allowWildcard: true })).toBe(true);
  });

  it('builds a consistent quoting warning', () => {
    const dir: ConfDirective = { key: 'FIELDALIAS-a', value: '', line: 7, directiveType: 'FIELDALIAS', className: 'a' };
    const w = fieldQuotingWarning(dir, 'event.field', 'needs quotes');
    expect(w.level).toBe('warning');
    expect(w.file).toBe('props.conf');
    expect(w.line).toBe(7);
    expect(w.message).toBe(`FIELDALIAS-a: "event.field" needs quotes — single-quote it: 'event.field'.`);
    expect(w.suggestion).toBe("Use 'event.field' instead of event.field.");
  });
});
