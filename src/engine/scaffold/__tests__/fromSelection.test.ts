import { describe, it, expect } from 'vitest';
import { generalize, buildExtractFromSelection, timePrefixFromSelection, toCaptureGroupName } from '../fromSelection';
import { upsertDirectiveInStanza } from '../serialize';
import { parseConf } from '../../parser/confParser';

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

  it('edits the definition that wins: the last line in the last block (#431)', () => {
    const text =
      '[web]\nTIME_PREFIX = a\nTIME_PREFIX = b\n\n[db]\nKV_MODE = json\n\n[web]\nTIME_PREFIX = c\nTIME_PREFIX = d';
    expect(upsertDirectiveInStanza(text, 'web', 'TIME_PREFIX', 'e')).toBe(
      '[web]\nTIME_PREFIX = a\nTIME_PREFIX = b\n\n[db]\nKV_MODE = json\n\n[web]\nTIME_PREFIX = c\nTIME_PREFIX = e',
    );
  });

  it('appends to the last block of a split stanza when the key is not in it (#431)', () => {
    const text = '[web]\nTIME_PREFIX = a\n\n[db]\nKV_MODE = json\n\n[web]\nKV_MODE = none\n';
    expect(upsertDirectiveInStanza(text, 'web', 'TIME_PREFIX', 'b')).toBe(
      '[web]\nTIME_PREFIX = a\n\n[db]\nKV_MODE = json\n\n[web]\nKV_MODE = none\nTIME_PREFIX = b\n',
    );
  });
  // #484. A line ending in an ODD number of backslashes continues onto the next
  // (props.conf.spec: "A backslash at the end of a line continues the value"), so
  // replacing a directive replaces every physical line it spans.
  describe('a directive continued with backslashes (#484)', () => {
    const valueOf = (text: string, key: string): string | undefined =>
      parseConf(text, 'props.conf')
        .stanzas.flatMap((st) => st.directives)
        .find((d) => d.key === key)?.value;

    it('replaces the whole continued REGEX, not just its first line', () => {
      const text = '[web]\nREGEX = a\\\n  b\\\n  c\nKV_MODE = none';
      const out = upsertDirectiveInStanza(text, 'web', 'REGEX', 'z');
      expect(out).toBe('[web]\nREGEX = z\nKV_MODE = none');
      expect(parseConf(out, 'props.conf').errors).toEqual([]);
    });

    it('replaces a continued EXTRACT at the end of the file', () => {
      const text = '[web]\nEXTRACT-u = user=(?<user>\\w+)\\\n  \\s+id=(?<id>\\d+)';
      const out = upsertDirectiveInStanza(text, 'web', 'EXTRACT-u', 'x=(?<x>\\d+)');
      expect(out).toBe('[web]\nEXTRACT-u = x=(?<x>\\d+)');
      expect(valueOf(out, 'EXTRACT-u')).toBe('x=(?<x>\\d+)');
    });

    it('replaces a continued value whose continuation line looks like a header or a comment', () => {
      const text = '[web]\nREGEX = a\\\n[not-a-stanza]\\\n# not a comment\nKV_MODE = none\n\n[db]\nKV_MODE = json';
      expect(upsertDirectiveInStanza(text, 'web', 'REGEX', 'z')).toBe(
        '[web]\nREGEX = z\nKV_MODE = none\n\n[db]\nKV_MODE = json',
      );
    });

    it('does not treat a value ending in an even number of backslashes as continued', () => {
      // `C:\\dir\\` is escaped backslashes, so the next line is a directive of its own.
      const text = '[web]\nSEDCMD-p = s/C:\\\\dir\\\\\nKV_MODE = none';
      expect(upsertDirectiveInStanza(text, 'web', 'SEDCMD-p', 'x')).toBe('[web]\nSEDCMD-p = x\nKV_MODE = none');
    });

    it('still treats three trailing backslashes as a continuation', () => {
      const text = '[web]\nREGEX = a\\\\\\\nb\nKV_MODE = none';
      expect(upsertDirectiveInStanza(text, 'web', 'REGEX', 'z')).toBe('[web]\nREGEX = z\nKV_MODE = none');
    });

    it('ends a continuation at a blank line, which belongs to the directive', () => {
      const text = '[web]\nREGEX = a\\\n\nKV_MODE = none';
      expect(upsertDirectiveInStanza(text, 'web', 'REGEX', 'z')).toBe('[web]\nREGEX = z\nKV_MODE = none');
    });

    it('edits the last definition when an earlier one is continued', () => {
      const text = '[web]\nREGEX = a\\\n  b\nREGEX = c\\\n  d';
      expect(upsertDirectiveInStanza(text, 'web', 'REGEX', 'z')).toBe('[web]\nREGEX = a\\\n  b\nREGEX = z');
    });

    it('does not mistake a continuation line that reads `KEY =` for the definition', () => {
      const text = '[web]\nKV_MODE = none\nEXTRACT-a = x\\\n  REGEX = inner';
      const out = upsertDirectiveInStanza(text, 'web', 'REGEX', 'z');
      expect(out).toBe('[web]\nKV_MODE = none\nEXTRACT-a = x\\\n  REGEX = inner\nREGEX = z');
      expect(valueOf(out, 'EXTRACT-a')).toBe('x  REGEX = inner');
    });

    it('keeps a continued directive whole when appending after it', () => {
      const text = '[web]\nREGEX = a\\\n  b\\\n\n[db]\nKV_MODE = json';
      const out = upsertDirectiveInStanza(text, 'web', 'KV_MODE', 'none');
      expect(out).toBe('[web]\nREGEX = a\\\n  b\\\n\nKV_MODE = none\n[db]\nKV_MODE = json');
      expect(valueOf(out, 'REGEX')).toBe('a  b');
    });

    it('recognises the continuation in a CRLF file and keeps its line endings', () => {
      const text = '[web]\r\nREGEX = a\\\r\n  b\r\nKV_MODE = none\r\n';
      expect(upsertDirectiveInStanza(text, 'web', 'REGEX', 'z')).toBe('[web]\r\nREGEX = z\r\nKV_MODE = none\r\n');
    });

    it('does not let a stanza header that is continued text end the stanza', () => {
      const text = '[web]\nREGEX = a\\\n[x]\nKV_MODE = none';
      expect(upsertDirectiveInStanza(text, 'web', 'KV_MODE', 'json')).toBe('[web]\nREGEX = a\\\n[x]\nKV_MODE = json');
    });
  });
});
