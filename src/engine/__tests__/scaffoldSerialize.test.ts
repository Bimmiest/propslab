import { describe, it, expect } from 'vitest';
import { stanzaNameError, renderStanza } from '../scaffold/serialize';
import { generalize, buildExtractFromSelection } from '../scaffold/fromSelection';

// A sourcetype like `foo]bar` would write `[foo]bar]`, which does not
// round-trip as one stanza, so such a name blocks Apply.
describe('stanzaNameError (#35.1)', () => {
  it('rejects a name containing a closing bracket', () => {
    expect(stanzaNameError('foo]bar')).toMatch(/\[|\]/);
  });

  it('rejects a name containing an opening bracket', () => {
    expect(stanzaNameError('foo[bar')).not.toBeNull();
  });

  it('rejects a name containing a line break', () => {
    expect(stanzaNameError('foo\nbar')).toMatch(/line break/i);
  });

  it('rejects an empty name', () => {
    expect(stanzaNameError('   ')).not.toBeNull();
  });

  it('accepts ordinary sourcetypes', () => {
    for (const name of ['my:sourcetype', 'pan:traffic', 'aws:cloudtrail', 'app_api']) {
      expect(stanzaNameError(name)).toBeNull();
    }
  });

  it('a valid name still round-trips through renderStanza', () => {
    const rendered = renderStanza('my:sourcetype', [
      { key: 'TRUNCATE', value: '0', confidence: 'medium', evidence: '', enabledByDefault: true },
    ]);
    expect(rendered.split('\n')[0]).toBe('[my:sourcetype]');
  });
});

// `\S+` runs past the closing quote of a JSON value.
describe('generalize — quoted values (#35.2)', () => {
  it('stops at the closing quote inside a quoted JSON value', () => {
    const raw = '{"email":"x@y.com"}';
    const directive = buildExtractFromSelection(raw, 'x@y.com', 'email', raw.indexOf('x@y.com'));
    expect(directive!.value).toContain('[^"]+');
    expect(directive!.value).not.toContain('\\S+');
  });

  it('captures only the value, not the trailing quote and brace', () => {
    const raw = '{"email":"x@y.com"}';
    const directive = buildExtractFromSelection(raw, 'x@y.com', 'email', raw.indexOf('x@y.com'));
    const match = new RegExp(directive!.value).exec(raw);
    expect(match?.groups?.email).toBe('x@y.com');
  });

  it('still uses \\S+ for an unquoted token', () => {
    expect(generalize('x@y.com')).toBe('\\S+');
  });

  it('leaves the simpler generalisations alone', () => {
    expect(generalize('12345', true)).toBe('\\d+');
    expect(generalize('word', true)).toBe('\\w+');
  });
});
