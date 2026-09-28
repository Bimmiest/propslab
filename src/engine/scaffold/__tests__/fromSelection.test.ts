import { describe, it, expect } from 'vitest';
import { generalize, buildExtractFromSelection, timePrefixFromSelection, toCaptureGroupName } from '../fromSelection';
import { upsertDirectiveInStanza } from '../serialize';

describe('generalize', () => {
  it('generalises by shape', () => {
    expect(generalize('12345')).toBe('\\d+');
    expect(generalize('10.0.0.1')).toBe('\\d+\\.\\d+\\.\\d+\\.\\d+');
    expect(generalize('aaaaaaaa-1111-2222-3333-444444444444')).toBe('[0-9a-fA-F-]+');
    expect(generalize('alice')).toBe('\\w+');
    expect(generalize('a/b?c')).toBe('\\S+');
  });
});

describe('buildExtractFromSelection', () => {
  it('anchors on the stable preceding boundary and names the field', () => {
    const raw = 'id=5 user=alice action=login';
    const d = buildExtractFromSelection(raw, 'alice', 'user');
    expect(d).toEqual({ key: 'EXTRACT-user', value: 'user=(?<user>\\w+)' });
  });

  it('captures an IP with no usable prefix', () => {
    const raw = '10.0.0.1 - - request';
    const d = buildExtractFromSelection(raw, '10.0.0.1', 'clientip');
    expect(d?.value).toBe('(?<clientip>\\d+\\.\\d+\\.\\d+\\.\\d+)');
  });

  it('defaults the field name and returns null for empty selection', () => {
    expect(buildExtractFromSelection('x=1', '1', '')?.key).toBe('EXTRACT-field');
    expect(buildExtractFromSelection('x=1', '', 'f')).toBeNull();
  });

  // Anchor on the selection's real offset, not the first occurrence.
  it('anchors on the selection offset rather than the first match', () => {
    const raw = 'status=200 code=200';
    // Selecting the second "200" (in code=200, offset 16).
    const d = buildExtractFromSelection(raw, '200', 'rc', 16);
    expect(d?.value).toBe('code=(?<rc>\\d+)');
    // Without the offset it wrongly anchors on status=.
    const noOffset = buildExtractFromSelection(raw, '200', 'rc');
    expect(noOffset?.value).toBe('status=(?<rc>\\d+)');
  });

  // An illegal field name is sanitised into a valid capture group so the
  // regex compiles (instead of the dialog reporting a misleading "invalid regex").
  it('sanitises an illegal field name into a valid capture group', () => {
    const d = buildExtractFromSelection('a-b=200', '200', 'client-ip');
    expect(d?.key).toBe('EXTRACT-client_ip');
    expect(d?.value).toContain('(?<client_ip>');
    expect(() => new RegExp(d!.value)).not.toThrow();
  });

  it('prefixes a leading-digit field name', () => {
    const d = buildExtractFromSelection('x=1', '1', '2nd');
    expect(d?.value).toContain('(?<_2nd>');
    expect(() => new RegExp(d!.value)).not.toThrow();
  });
});

describe('toCaptureGroupName', () => {
  it('replaces illegal characters and prefixes a leading digit', () => {
    expect(toCaptureGroupName('client-ip')).toBe('client_ip');
    expect(toCaptureGroupName('user.name')).toBe('user_name');
    expect(toCaptureGroupName('2nd')).toBe('_2nd');
    expect(toCaptureGroupName('  ')).toBe('field');
    expect(toCaptureGroupName('ok_1')).toBe('ok_1');
  });
});

describe('timePrefixFromSelection', () => {
  it('derives the escaped literal before the timestamp', () => {
    const raw = '192.168.1.10 - frank [10/Oct/2000:13:55:36 -0700] "GET /"';
    expect(timePrefixFromSelection(raw, '10/Oct/2000:13:55:36 -0700')).toBe('\\[');
  });

  it('returns null when the timestamp is at the start', () => {
    expect(timePrefixFromSelection('2024-01-15T10:00:00 msg', '2024-01-15T10:00:00')).toBeNull();
  });
});

describe('upsertDirectiveInStanza', () => {
  it('appends a directive to the end of the stanza', () => {
    const out = upsertDirectiveInStanza('[web]\nKV_MODE = none', 'web', 'EXTRACT-user', 'user=(?<user>\\w+)');
    expect(out).toBe('[web]\nKV_MODE = none\nEXTRACT-user = user=(?<user>\\w+)');
  });

  it('replaces an existing directive of the same key in place', () => {
    const out = upsertDirectiveInStanza('[web]\nTIME_PREFIX = old\nKV_MODE = none', 'web', 'TIME_PREFIX', '\\[');
    expect(out).toBe('[web]\nTIME_PREFIX = \\[\nKV_MODE = none');
  });

  it('appends a new stanza when the target is absent', () => {
    const out = upsertDirectiveInStanza('[other]\nKV_MODE = json', 'web', 'TIME_PREFIX', '\\[');
    expect(out).toBe('[other]\nKV_MODE = json\n\n[web]\nTIME_PREFIX = \\[\n');
  });

  it('appends at the end of the stanza block without bleeding into the next stanza', () => {
    const out = upsertDirectiveInStanza('[web]\nKV_MODE = none\n\n[db]\nKV_MODE = json', 'web', 'TIME_PREFIX', '\\[');
    expect(out).toBe('[web]\nKV_MODE = none\nTIME_PREFIX = \\[\n\n[db]\nKV_MODE = json');
  });
});
