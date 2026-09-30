import { describe, it, expect } from 'vitest';
import { extractFields } from '../fieldExtractor';
import { applySedCommands } from '../sedCmd';
import type { SplunkEvent, ConfDirective } from '../../types';
import { runCtx } from '../../__tests__/runCtx';
import { makeEvent } from '../../../test/makeEvent';

// Zero-based line numbers and this metadata are what this file always built.
function event(raw: string): SplunkEvent {
  return makeEvent(raw, {
    metadata: { index: 'main', source: 'test', host: 'host', sourcetype: 'test' },
    lineNumbers: { start: 0, end: 0 },
  });
}

function makeDirective(type: string, className: string, value: string): ConfDirective {
  return { directiveType: type, className, key: `${type}-${className}`, value, line: 0 };
}

describe('extractFields — statelessness', () => {
  const directives = [makeDirective('EXTRACT', 'myfield', '(?<user>\\w+) (?<action>\\w+)')];

  it('extracts fields identically on first and second call', () => {
    const events = [event('alice login'), event('bob logout')];
    const first = extractFields(events, directives, runCtx());
    const second = extractFields(events, directives, runCtx());
    expect(first[0]!.fields).toEqual(second[0]!.fields);
    expect(first[1]!.fields).toEqual(second[1]!.fields);
  });

  it('extracts fields from every event, not just the first', () => {
    const events = [event('alice login'), event('bob logout')];
    const result = extractFields(events, directives, runCtx());
    expect(result[0]!.fields['user']).toBe('alice');
    expect(result[1]!.fields['user']).toBe('bob');
  });
});

describe('applySedCommands — statelessness', () => {
  const directives = [makeDirective('SEDCMD', 'redact', 's/foo/bar/g')];

  it('replaces identically on first and second call', () => {
    const events = [event('foo baz foo'), event('foo qux')];
    const first = applySedCommands(events, directives, runCtx());
    const second = applySedCommands(events, directives, runCtx());
    expect(first[0]!._raw).toBe(second[0]!._raw);
    expect(first[1]!._raw).toBe(second[1]!._raw);
  });

  it('replaces all occurrences in every event', () => {
    const events = [event('foo baz foo'), event('foo qux')];
    const result = applySedCommands(events, directives, runCtx());
    expect(result[0]!._raw).toBe('bar baz bar');
    expect(result[1]!._raw).toBe('bar qux');
  });
});
