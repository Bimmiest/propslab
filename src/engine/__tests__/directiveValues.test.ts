// ---------------------------------------------------------------------------
// directiveValues.test.ts
// The shared directive lookup and conf-boolean reading.
//
// The helper tests pin the semantics. The per-directive tests below them pin
// that each directive accepts every one of Splunk's boolean spellings,
// trimmed, and points its diagnostic at the effective definition. The
// spellings are Splunk's conf booleans as splunk.util.normalizeBoolean reads
// them — doc-derived; no capture exercises an alternative spelling.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  effectiveBool,
  effectiveDirective,
  effectiveValue,
  isSplunkBoolLiteral,
  parseSplunkBool,
} from '../utils/directiveValues';
import { applyKvMode } from '../processors/kvMode';
import { breakLines } from '../processors/lineBreaker';
import { getAllDirectives } from '../directiveRegistry';
import { lintDirectiveValues } from '../directiveLint';
import { annotatePunct } from '../processors/punctAnnotator';
import { applyIndexedExtractions } from '../processors/indexedExtractions';
import { applyRegexTransform } from '../transforms/regexTransform';
import { lintMatchedDirectives } from '../configLint';
import { runPipeline } from '../pipeline';
import type { ConfDirective, ConfStanza, EventMetadata, SplunkEvent, ValidationDiagnostic } from '../types';
import { runCtx } from './runCtx';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function d(key: string, value: string, line = 1): ConfDirective {
  return { key, value, line, directiveType: key };
}

function event(raw: string): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { ...META },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

function stanza(name: string, directives: Record<string, string>): ConfStanza {
  return {
    name,
    type: 'sourcetype',
    directives: Object.entries(directives).map(([k, v], i) => d(k, v, i + 2)),
    lineRange: { start: 1, end: Object.keys(directives).length + 1 },
  };
}

const TRUE_SPELLINGS = ['1', 'true', 'TRUE', 't', 'yes', 'Y', 'on', ' true '];
const FALSE_SPELLINGS = ['0', 'false', 'False', 'f', 'no', 'N', 'off', ' false '];

describe('effectiveDirective / effectiveValue', () => {
  it('returns the last definition, which is the one Splunk applies', () => {
    const list = [d('REGEX', 'first', 1), d('FORMAT', 'x', 2), d('REGEX', 'second', 3)];
    expect(effectiveDirective(list, 'REGEX')?.line).toBe(3);
    expect(effectiveDirective(list, 'DEST_KEY')).toBeUndefined();
  });

  it('trims the value, and is undefined for an absent key', () => {
    expect(effectiveValue([d('KV_MODE', ' json  ')], 'KV_MODE')).toBe('json');
    expect(effectiveValue([], 'KV_MODE')).toBeUndefined();
  });
});

describe('parseSplunkBool', () => {
  it.each(TRUE_SPELLINGS)('reads %j as true', (v) => {
    expect(parseSplunkBool(v, false)).toBe(true);
    expect(isSplunkBoolLiteral(v)).toBe(true);
  });

  it.each(FALSE_SPELLINGS)('reads %j as false', (v) => {
    expect(parseSplunkBool(v, true)).toBe(false);
    expect(isSplunkBoolLiteral(v)).toBe(true);
  });

  it('falls back to the default only when absent or empty', () => {
    for (const fallback of [true, false]) {
      expect(parseSplunkBool(undefined, fallback)).toBe(fallback);
      expect(parseSplunkBool('', fallback)).toBe(fallback);
      expect(parseSplunkBool('  ', fallback)).toBe(fallback);
    }
    expect(isSplunkBoolLiteral('maybe')).toBe(false);
    expect(isSplunkBoolLiteral('')).toBe(false);
  });

  it('reads any other value as false, whatever the default (Splunk normalizeBoolean)', () => {
    for (const fallback of [true, false]) {
      expect(parseSplunkBool('maybe', fallback)).toBe(false);
      expect(parseSplunkBool('nope', fallback)).toBe(false);
      expect(parseSplunkBool('2', fallback)).toBe(false);
    }
  });

  it('effectiveBool reads the last definition', () => {
    expect(effectiveBool([d('MV_ADD', 'true'), d('MV_ADD', 'no')], 'MV_ADD', true)).toBe(false);
    expect(effectiveBool([], 'MV_ADD', true)).toBe(true);
  });
});

// ── Behaviour changes: default-false settings that read only `true` ─────────

describe('SHOULD_LINEMERGE accepts every true spelling (was: exactly "true", untrimmed)', () => {
  const raw = '2026-01-15 10:00:00 a\ncontinued\n2026-01-15 10:00:01 b';

  it.each(['1', 'yes', 't', 'on', 'true '])('merges for %j', (v) => {
    expect(breakLines(raw, [d('SHOULD_LINEMERGE', v)], META, runCtx())).toHaveLength(2);
  });

  it('still reads an explicit non-boolean as false, as it did', () => {
    expect(breakLines(raw, [d('SHOULD_LINEMERGE', 'maybe')], META, runCtx())).toHaveLength(3);
  });
});

describe('WRITE_META, REPEAT_MATCH, MV_ADD and JSON_TRIM_BRACES_IN_ARRAY_NAMES accept 1/yes (was: exactly "true")', () => {
  it('WRITE_META = 1 strips the leading underscore as WRITE_META = true does', () => {
    const s = stanza('t', { REGEX: '(?<_user>\\w+)', WRITE_META: '1' });
    expect(applyRegexTransform(event('alice'), s).fields).toEqual({ user: 'alice' });
  });

  it('REPEAT_MATCH = yes runs the index-time REGEX more than once', () => {
    const s = stanza('t', { REGEX: '(\\d)', FORMAT: 'n::$1', REPEAT_MATCH: 'yes' });
    expect(applyRegexTransform(event('1 2'), s).fields).toEqual({ n: ['1', '2'] });
  });

  it('MV_ADD = 1 keeps later search-time values', () => {
    const s = stanza('t', { REGEX: '(\\d)', FORMAT: 'n::$1', MV_ADD: '1' });
    expect(applyRegexTransform(event('1 2'), s, undefined, 'search-time').fields).toEqual({ n: ['1', '2'] });
  });

  it('JSON_TRIM_BRACES_IN_ARRAY_NAMES = yes strips the {} marker', () => {
    const [e] = applyIndexedExtractions(
      [event('{"a":["x","y"]}')],
      [d('INDEXED_EXTRACTIONS', 'json'), d('JSON_TRIM_BRACES_IN_ARRAY_NAMES', 'yes')],
      runCtx(),
    );
    expect(e?.fields['a']).toEqual(['x', 'y']);
  });
});

// ── Behaviour changes: default-true settings that read only `false` ─────────

describe('default-true settings accept every false spelling (was: exactly "false", or false/0)', () => {
  it.each(['0', 'no', 'f', 'off'])('AUTO_KV_JSON = %s turns automatic JSON off', (v) => {
    const [e] = applyKvMode([event('{"action":"login"}')], [d('AUTO_KV_JSON', v)], runCtx());
    expect(e?.fields['action']).toBeUndefined();
  });

  it('KV_TRIM_SPACES = off keeps the outer spaces (off was the one false spelling it missed)', () => {
    const [e] = applyKvMode([event('a="  x  "')], [d('KV_TRIM_SPACES', 'off')], runCtx());
    expect(e?.fields['a']).toBe('  x  ');
  });

  it.each(['0', 'no'])('BREAK_ONLY_BEFORE_DATE = %s stops breaking before dates', (v) => {
    const raw = '2026-01-15 10:00:00 a\n2026-01-15 10:00:01 b';
    expect(breakLines(raw, [d('BREAK_ONLY_BEFORE_DATE', v)], META, runCtx())).toHaveLength(1);
  });

  it.each(['0', 'no'])('ANNOTATE_PUNCT = %s drops the punct field', (v) => {
    const [e] = annotatePunct([event('a=b')], [d('ANNOTATE_PUNCT', v)], runCtx());
    expect(e?.fields['punct']).toBeUndefined();
  });

  it.each(['no', 'f'])('CLEAN_KEYS = %s leaves a key uncleaned', (v) => {
    const s = stanza('raw', { REGEX: '([\\w.\\-]+)=(\\w+)', FORMAT: '$1::$2', CLEAN_KEYS: v });
    expect(applyRegexTransform(event('my.odd-key=value'), s, undefined, 'search-time').fields).toEqual({
      'my.odd-key': 'value',
    });
  });

  it('XML_IE_SKIP_XML_ENCODED_VALS = 0 indexes the decoded value', () => {
    const [e] = applyIndexedExtractions(
      [event("<Event><EventData><Data Name='Cmd'>a &amp; b</Data></EventData></Event>")],
      [
        d('INDEXED_EXTRACTIONS', 'xmlkv-winevt'),
        d('XML_INDEXED_EXTRACTIONS_PIPELINE', 'typing'),
        d('XML_IE_SKIP_XML_ENCODED_VALS', '0'),
      ],
      runCtx(),
    );
    expect(e?.fields['Cmd']).toBe('a & b');
  });

  it('the INDEXED_EXTRACTIONS = json duplicate warning reads AUTO_KV_JSON the way KV_MODE does', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    lintMatchedDirectives([d('INDEXED_EXTRACTIONS', 'json'), d('AUTO_KV_JSON', 'no')], diagnostics);
    expect(diagnostics).toEqual([]);
  });
});

// ── Behaviour changes: diagnostics that pointed at a shadowed definition ────

describe('transforms diagnostics point at the definition that took effect (was: the first)', () => {
  const run = (transforms: string) =>
    runPipeline('hello world\n', META, '[st]\nTRANSFORMS-x = t1\n', transforms, {
      perEventPipeline: false,
      captureOffsets: false,
    }).diagnostics;

  it('an unknown DEST_KEY is reported on the line that set it', () => {
    // The router's own warning, not configLint's (which already read the last).
    const diag = run('[t1]\nREGEX = (\\w+)\nDEST_KEY = queue\nDEST_KEY = not_a_key\nFORMAT = x\n').find((x) =>
      x.message.includes('in transform "t1" is not a recognized'),
    );
    expect(diag).toBeDefined();
    expect(diag?.line).toBe(4);
  });

  it('REPEAT_MATCH beside DEST_KEY = _raw is reported on the effective REPEAT_MATCH', () => {
    const diag = run(
      '[t1]\nREPEAT_MATCH = false\nREGEX = (\\w+)\nDEST_KEY = _raw\nFORMAT = $1\nREPEAT_MATCH = true\n',
    ).find((x) => x.message.includes('ignored when DEST_KEY = _raw'));
    expect(diag?.line).toBe(6);
  });

  it('the DEST_KEY = _raw data-loss warning is placed on the DEST_KEY that ran', () => {
    const diag = run('[t1]\nDEST_KEY = queue\nREGEX = (h)\nDEST_KEY = _raw\nFORMAT = $1\n').find((x) =>
      x.message.includes('replaced the event and dropped'),
    );
    expect(diag).toBeDefined();
    expect(diag?.line).toBe(4);
  });
});

// ── One rule for every boolean (#473) ───────────────────────────────────────

describe('every boolean directive follows one rule (#473)', () => {
  const spellings = [...TRUE_SPELLINGS, ...FALSE_SPELLINGS];
  const value = fc.oneof(fc.constantFrom(...spellings, 'nope', 'maybe', '2', 'truee', 'onn'), fc.string({ maxLength: 6 }));
  const booleanDirectives = getAllDirectives().filter((info) => info.valueType === 'boolean');

  it('the registry has boolean directives to check', () => {
    expect(booleanDirectives.length).toBeGreaterThan(5);
  });

  it('parseSplunkBool: true spellings are true, everything else false, empty takes the default', () => {
    fc.assert(
      fc.property(value, fc.boolean(), (v, fallback) => {
        const t = v.trim().toLowerCase();
        const expected = t === '' ? fallback : ['1', 'true', 't', 'yes', 'y', 'on'].includes(t);
        expect(parseSplunkBool(v, fallback)).toBe(expected);
      }),
    );
  });

  it('the linter flags a boolean directive exactly when the reader will not recognise its value', () => {
    fc.assert(
      fc.property(fc.constantFrom(...booleanDirectives), value, (info, v) => {
        const file = info.appliesTo === 'transforms.conf' ? 'transforms.conf' : 'props.conf';
        const diagnostics: ValidationDiagnostic[] = [];
        lintDirectiveValues([stanza('x', { [info.key]: v })], file, diagnostics);
        const empty = v.trim() === '';
        expect(diagnostics.length > 0).toBe(!empty && !isSplunkBoolLiteral(v));
        for (const diag of diagnostics) expect(diag.message).toContain('reads an unrecognised value as false');
        // ...and what the linter says is what the reader does.
        if (!empty && !isSplunkBoolLiteral(v)) {
          expect(parseSplunkBool(v, true)).toBe(false);
          expect(parseSplunkBool(v, false)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('the readers agree: a non-boolean value switches a default-true and a default-false setting off', () => {
    const raw = '2026-01-15 10:00:00 a\ncontinued\n2026-01-15 10:00:01 b';
    // default-true: ANNOTATE_PUNCT, BREAK_ONLY_BEFORE_DATE, CLEAN_KEYS
    const [punct] = annotatePunct([event('a=b')], [d('ANNOTATE_PUNCT', 'nope')], runCtx());
    expect(punct?.fields['punct']).toBeUndefined();
    expect(breakLines('2026-01-15 10:00:00 a\n2026-01-15 10:00:01 b', [d('BREAK_ONLY_BEFORE_DATE', 'nope')], META, runCtx())).toHaveLength(1);
    const s = stanza('raw', { REGEX: '([\\w.\\-]+)=(\\w+)', FORMAT: '$1::$2', CLEAN_KEYS: 'nope' });
    expect(applyRegexTransform(event('my.odd-key=value'), s, undefined, 'search-time').fields).toEqual({ 'my.odd-key': 'value' });
    // SHOULD_LINEMERGE, whatever the structured-format default would have been.
    expect(breakLines(raw, [d('SHOULD_LINEMERGE', 'nope')], META, runCtx())).toHaveLength(3);
    expect(
      breakLines(raw, [d('INDEXED_EXTRACTIONS', 'csv'), d('SHOULD_LINEMERGE', 'nope')], META, runCtx()),
    ).toHaveLength(3);
    // An empty SHOULD_LINEMERGE keeps the default (merging on).
    expect(breakLines(raw, [d('SHOULD_LINEMERGE', '')], META, runCtx())).toHaveLength(2);
  });
});
