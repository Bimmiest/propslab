// ---------------------------------------------------------------------------
// directiveLint.test.ts
// The two rules that catch mistakes Splunk itself is silent about (#177, #179).
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

const metadata: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function diagnosticsFor(props: string, transforms = '') {
  return runPipeline('2026-01-15T10:00:00Z hello world\n', metadata, `[st]\n${props}`, transforms, {
    perEventPipeline: false,
    captureOffsets: false,
  }).diagnostics;
}

const messagesFor = (props: string, transforms = '') =>
  diagnosticsFor(props, transforms).map((d) => d.message);

describe('#177 — a transforms setting that is inert in its phase', () => {
  it('flags a search-time-only setting in a TRANSFORMS- stanza', () => {
    const d = diagnosticsFor(
      'TRANSFORMS-x = t1\n',
      '[t1]\nREGEX = (\\w+)\nFORMAT = a::$1\nMV_ADD = true\n',
    ).find((x) => x.directiveKey === 'MV_ADD');
    expect(d?.level).toBe('warning');
    expect(d?.message).toContain('does nothing here');
    expect(d?.message).toContain('TRANSFORMS-');
    expect(d?.file).toBe('transforms.conf');
  });

  it('flags an index-time-only setting in a REPORT- stanza', () => {
    const d = diagnosticsFor(
      'REPORT-x = t1\n',
      '[t1]\nREGEX = (?<a>\\w+)\nREPEAT_MATCH = true\n',
    ).find((x) => x.directiveKey === 'REPEAT_MATCH');
    expect(d?.message).toContain('REPORT-');
    expect(d?.message).toContain('index-time');
  });

  it('says nothing when the setting is live for that phase', () => {
    const msgs = messagesFor('REPORT-x = t1\n', '[t1]\nREGEX = (\\w+)\nFORMAT = a::$1\nMV_ADD = true\n');
    expect(msgs.filter((m) => m.includes('does nothing here'))).toEqual([]);
  });

  it('stays quiet for a stanza reached from both, where every setting is live somewhere', () => {
    const msgs = messagesFor(
      'TRANSFORMS-a = t1\nREPORT-b = t1\n',
      '[t1]\nREGEX = (\\w+)\nFORMAT = a::$1\nMV_ADD = true\nREPEAT_MATCH = true\n',
    );
    expect(msgs.filter((m) => m.includes('does nothing here'))).toEqual([]);
  });

  it('stays quiet for a stanza props.conf never references', () => {
    const msgs = messagesFor('', '[orphan]\nREGEX = (\\w+)\nMV_ADD = true\n');
    expect(msgs.filter((m) => m.includes('does nothing here'))).toEqual([]);
  });

  it('flags REPEAT_MATCH alongside DEST_KEY = _raw, which the spec calls out separately', () => {
    const d = diagnosticsFor(
      'TRANSFORMS-x = t1\n',
      '[t1]\nREGEX = (\\w+)\nDEST_KEY = _raw\nFORMAT = x\nREPEAT_MATCH = true\n',
    ).find((x) => x.message.includes('ignored when DEST_KEY = _raw'));
    expect(d).toBeDefined();
  });
});

describe('#179 — a value that is not the documented type', () => {
  it('flags a boolean that is not a boolean literal', () => {
    const d = diagnosticsFor('SHOULD_LINEMERGE = yes please\n').find(
      (x) => x.directiveKey === 'SHOULD_LINEMERGE',
    );
    expect(d?.level).toBe('warning');
    expect(d?.message).toContain('takes a boolean');
  });

  it('accepts every boolean spelling Splunk does', () => {
    for (const v of ['true', 'False', '1', '0', 't', 'f', 'yes', 'no']) {
      const msgs = messagesFor(`SHOULD_LINEMERGE = ${v}\n`);
      expect(msgs.filter((m) => m.includes('takes a boolean')), `for ${v}`).toEqual([]);
    }
  });

  it('flags a non-numeric integer', () => {
    const d = diagnosticsFor('TRUNCATE = lots\n').find((x) => x.directiveKey === 'TRUNCATE');
    expect(d?.message).toContain('takes an integer');
  });

  it('flags a negative where the spec says non-negative', () => {
    const d = diagnosticsFor('TRUNCATE = -1\n').find((x) => x.directiveKey === 'TRUNCATE');
    expect(d?.message).toContain('cannot be negative');
  });

  // Doc-derived (#286): props.conf.spec documents -1 as disabling the lookahead
  // limit, so it is a setting rather than a mistake. Other negatives still are.
  it('accepts MAX_TIMESTAMP_LOOKAHEAD = -1, which the spec documents as "no limit"', () => {
    const lint = (v: string) =>
      diagnosticsFor(`MAX_TIMESTAMP_LOOKAHEAD = ${v}\n`).filter(
        (x) => x.directiveKey === 'MAX_TIMESTAMP_LOOKAHEAD' && x.message.includes('cannot be negative'),
      );
    expect(lint('-1')).toEqual([]);
    expect(lint('-2')).toHaveLength(1);
  });

  it('flags a value outside a documented enum, and lists the valid ones', () => {
    const d = diagnosticsFor('KV_MODE = XLM\n').find((x) => x.directiveKey === 'KV_MODE');
    expect(d?.message).toContain('does not accept');
    expect(d?.message).toContain('auto_escaped');
  });

  it('accepts the one enum member that carries an argument', () => {
    const msgs = messagesFor('KV_MODE = multi:mystanza\n');
    expect(msgs.filter((m) => m.includes('does not accept'))).toEqual([]);
  });

  it('treats an empty value as a reset rather than a type error', () => {
    const msgs = messagesFor('TRUNCATE =\n');
    expect(msgs.filter((m) => m.includes('takes an integer'))).toEqual([]);
  });

  it('says nothing about a correct config', () => {
    const msgs = messagesFor('SHOULD_LINEMERGE = false\nTRUNCATE = 10000\nKV_MODE = auto\n');
    expect(msgs.filter((m) => /takes a|does not accept|cannot be negative/.test(m))).toEqual([]);
  });

  it('checks transforms.conf too', () => {
    const d = diagnosticsFor(
      'REPORT-x = t1\n',
      '[t1]\nREGEX = (\\w+)\nFORMAT = a::$1\nMV_ADD = maybe\n',
    ).find((x) => x.directiveKey === 'MV_ADD' && x.message.includes('takes a boolean'));
    expect(d).toBeDefined();
  });
});
