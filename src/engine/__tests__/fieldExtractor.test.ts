import { describe, it, expect } from 'vitest';
import { extractFields } from '../processors/fieldExtractor';
import type { SplunkEvent, ConfDirective } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

function event(raw: string, fields: Record<string, string | string[]> = {}): SplunkEvent {
  return makeEvent(raw, { fields });
}

function dir(className: string, value: string): ConfDirective {
  return { key: `EXTRACT-${className}`, value, line: 1, directiveType: 'EXTRACT', className };
}

describe('extractFields — fieldOffsets provenance', () => {
  it('records start/end offsets for positional captures against _raw', () => {
    const raw = '192.168.1.30 - admin [21/Apr/2026:10:00:00] "GET /x HTTP/1.0"';
    const e = extractFields([event(raw)], [dir('user', '^\\S+\\s+-\\s+(?<user>\\S+)\\s')], runCtx(FIXED_NOW))[0]!;
    expect(e.fields['user']).toBe('admin');
    const offsets = e.fieldOffsets?.['user'];
    expect(offsets).toHaveLength(1);
    const [s, end] = offsets![0]!;
    expect(raw.substring(s, end)).toBe('admin');
    // Authoritative position is the first 'admin', not any later repetition
    expect(s).toBe(raw.indexOf('admin'));
  });

  it('extracts only the first match (inline EXTRACT defaults to max_match=1)', () => {
    const raw = 'id=1 id=2 id=3';
    const e = extractFields([event(raw)], [dir('id', 'id=(?<id>\\d+)')], runCtx(FIXED_NOW))[0]!;
    // Inline EXTRACT is first-match-only — not multivalue. Multivalue requires a
    // transforms.conf REGEX with MV_ADD, which EXTRACT does not support.
    expect(e.fields['id']).toBe('1');
    const offsets = e.fieldOffsets?.['id'];
    expect(offsets).toHaveLength(1);
    expect(raw.substring(offsets![0]![0], offsets![0]![1])).toBe('1');
  });

  it('does not overwrite a field already set by an earlier EXTRACT (first wins)', () => {
    const raw = 'a=first a=second';
    // Class names sort alphabetically: aaa runs before bbb.
    const e = extractFields(
      [event(raw)],
      [dir('bbb', 'a=(?<val>\\w+)\\s'), dir('aaa', 'a=second')],
      runCtx(FIXED_NOW),
    )[0]!;
    // Both directives would set different things, but the key check: a field set
    // by the first-run extraction is not clobbered. Here `val` is set once.
    expect(e.fields['val']).toBe('first');
  });

  it('does not overwrite a pre-existing field value', () => {
    const raw = 'status=500';
    const e = extractFields(
      [event(raw, { status: '200' })],
      [dir('s', 'status=(?<status>\\d+)')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(e.fields['status']).toBe('200');
  });

  it('does not record offsets when EXTRACT targets a non-_raw source field', () => {
    const raw = 'payload: key=value';
    const e = extractFields(
      [event(raw, { message: 'key=value' })],
      [dir('key', '(?<k>\\w+)=(?<v>\\w+) in message')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(e.fields['k']).toBe('key');
    // Offsets would be positions inside `message`, not `_raw` — so they must not be recorded.
    expect(e.fieldOffsets?.['k']).toBeUndefined();
    expect(e.fieldOffsets?.['v']).toBeUndefined();
  });

  it('resolves a single-quoted "in" source field (nested JSON name with a period)', () => {
    const e = extractFields(
      [event('raw', { 'event.message': 'key=value' })],
      [dir('key', "(?<k>\\w+)=(?<v>\\w+) in 'event.message'")],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(e.fields['k']).toBe('key');
    expect(e.fields['v']).toBe('value');
  });

  it('distinguishes repeated identical values by capture position (double-highlight fix)', () => {
    // The reported bug: a regex-extracted value also happens to appear elsewhere in _raw.
    // With offsets, the highlighter targets exactly the capture position — not every indexOf hit.
    const raw = '192.168.1.30 - admin [...] "GET /admin/dashboard HTTP/1.0"';
    const e = extractFields([event(raw)], [dir('user', '^\\S+\\s+-\\s+(?<user>\\S+)\\s')], runCtx(FIXED_NOW))[0]!;
    const offsets = e.fieldOffsets?.['user'];
    expect(offsets).toHaveLength(1);
    // The offset points at the first `admin` (the field value), not `/admin/` in the URL.
    expect(offsets![0]![0]).toBe(raw.indexOf('admin'));
    expect(offsets![0]![0]).toBeLessThan(raw.indexOf('/admin/'));
  });
});

describe('extractFields — captureOffsets (#118)', () => {
  const raw = 'user=admin id=7';
  const dirs = [dir('user', 'user=(?<user>\\w+)')];

  it('captures offsets by default, so the browser keeps its highlighting', () => {
    const e = extractFields([event(raw)], dirs, runCtx(FIXED_NOW))[0]!;
    expect(e.fields['user']).toBe('admin');
    expect(e.fieldOffsets?.['user']).toHaveLength(1);
  });

  it('extracts the same fields with captureOffsets: false, but records no offsets', () => {
    const e = extractFields([event(raw)], dirs, runCtx(FIXED_NOW, undefined, { captureOffsets: false }))[0]!;
    // The point of the option is that ONLY the offsets go away. A caller that
    // renders no highlights must not lose extraction itself.
    expect(e.fields['user']).toBe('admin');
    expect(e.fieldOffsets?.['user']).toBeUndefined();
  });

  it('reports the same offsets PCRE gives, in JS string indices', () => {
    const e = extractFields([event('é😀 user=admin')], dirs, runCtx(FIXED_NOW))[0]!;
    expect(e.fieldOffsets?.['user']).toEqual([[9, 14]]);
  });
});
