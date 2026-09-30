// ---------------------------------------------------------------------------
// lintParity.test.ts
// The editor's diagnostics and the engine's directive lint are two
// implementations of one rule set for a directive's VALUE: a boolean must be a
// boolean spelling, a number an integer (and not negative where the spec says
// non-negative), an enum one of its members. They read the value through the
// same predicates (engine/utils/directiveValues), and this holds them to it:
// for the same text, `lintConfigs` and `computeDiagnostics` must report the
// same (line, severity, key) set for those rule families.
//
// diagnosticsParityProperties.test.ts covers line structure; this covers the
// value rules, which is where the two drifted (`KV_MODE = multi:cisco`,
// `TRUNCATE = 1.5`, `MAX_EVENTS = -5`).
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { editor } from 'monaco-editor';
import { computeDiagnostics } from '../splunkConfDiagnostics';
import { lintConfigs } from '../../engine/configLint';
import { parseConf } from '../../engine/parser/confParser';
import type { ValidationDiagnostic } from '../../engine/types';
import { fakeModel } from '../../test/fakeModel';
import { fcSeed } from '../../test/fcSeed';

fc.configureGlobal({ seed: fcSeed(500), numRuns: 400 });

type ConfFile = 'props.conf' | 'transforms.conf';

/** The value-rule messages, as the engine words them and as the editor words them. */
const ENGINE_VALUE_RULE = /takes a boolean|takes an integer|cannot be negative|does not accept/;
const EDITOR_VALUE_RULE = /^Expected boolean|^Expected an integer|cannot be negative|^Invalid value/;

/** The (line, severity, key) triples of the shared value rules, as the engine reports them. */
function engineFindings(text: string, file: ConfFile): Set<string> {
  const props = parseConf(file === 'props.conf' ? text : '', 'props.conf');
  const transforms = parseConf(file === 'transforms.conf' ? text : '', 'transforms.conf');
  const diagnostics: ValidationDiagnostic[] = [];
  lintConfigs(props, transforms, diagnostics);
  return new Set(
    diagnostics
      .filter((d) => d.file === file && ENGINE_VALUE_RULE.test(d.message))
      .map((d) => `${d.line}|${d.level}|${d.directiveKey}`),
  );
}

/** The same triples as the editor reports them; the key is read off the marker's line. */
function editorFindings(model: editor.ITextModel, file: ConfFile): Set<string> {
  const severity: Record<number, string> = { 8: 'error', 4: 'warning', 2: 'info', 1: 'hint' };
  return new Set(
    computeDiagnostics(model, file)
      .filter((m) => EDITOR_VALUE_RULE.test(m.message))
      .map((m) => {
        const key = model.getLineContent(m.startLineNumber).split('=')[0]?.trim();
        return `${m.startLineNumber}|${severity[m.severity]}|${key}`;
      }),
  );
}

/** Both linters over one text, the engine reading what the editor holds (`getValue`). */
function both(text: string, file: ConfFile): { engine: Set<string>; editor: Set<string> } {
  const model = fakeModel(text);
  return { engine: engineFindings(model.getValue(), file), editor: editorFindings(model, file) };
}

const keys = fc.constantFrom(
  'SHOULD_LINEMERGE',
  'ANNOTATE_PUNCT',
  'KV_MODE',
  'INDEXED_EXTRACTIONS',
  'TRUNCATE',
  'MAX_EVENTS',
  'MAX_TIMESTAMP_LOOKAHEAD',
  'HEADER_FIELD_LINE_NUMBER',
  'NOT_A_KEY',
);

const values = fc.oneof(
  fc.constantFrom(
    'true',
    'FALSE',
    't',
    'nope',
    'on',
    ' yes ',
    '0',
    '1',
    'json',
    'JSON',
    'auto_escaped',
    'multi',
    'multi:cisco',
    'MULTI:x',
    'multi:',
    'xml:y',
    'bogus',
    '10',
    '+3',
    '-1',
    '-5',
    '-0',
    '1.5',
    '1e3',
    '0x10',
    'Infinity',
    'NaN',
    '',
    ' ',
    '12abc',
    '٣',
  ),
  fc.integer({ min: -20, max: 20 }).map(String),
  fc.string({ maxLength: 5 }).filter((s) => !s.includes('\\')),
);

const eols = fc.constantFrom('\n', '\r\n', '\r');

const directiveLine = fc
  .tuple(keys, values, fc.constantFrom('', '', '', 'cont'))
  .map(([k, v, tail]) => (tail === 'cont' ? `${k} = ${v}\\\n${v}` : `${k} = ${v}`));

const line = fc.oneof(
  { weight: 6, arbitrary: directiveLine },
  { weight: 1, arbitrary: fc.constantFrom('[st]', '[source::x]', '# c', '# TRUNCATE = abc', '', '[', 'garbage') },
);

const file = fc.array(fc.tuple(line, eols), { maxLength: 12 }).map((ls) => ls.map(([l, eol]) => l + eol).join(''));

describe('computeDiagnostics and lintConfigs report the same value problems', () => {
  it.each<ConfFile>(['props.conf', 'transforms.conf'])('on generated %s text', (fileType) => {
    fc.assert(
      fc.property(file, (text) => {
        const { engine, editor: editorSet } = both(text, fileType);
        expect([...editorSet].sort()).toEqual([...engine].sort());
      }),
    );
  });

  it('agrees on a file whose only line breaks are bare CRs, which Monaco splits on', () => {
    // The engine splits on \r?\n, so it must be handed what the editor holds:
    // the model normalises a lone CR to its EOL, and a lone-CR file is otherwise
    // one giant line to the engine and several to the editor.
    const text = 'TRUNCATE = 1.5\rMAX_EVENTS = -5\rKV_MODE = multi:cisco\rSHOULD_LINEMERGE = nope\r';
    const { engine, editor: editorSet } = both(text, 'props.conf');
    expect([...engine].sort()).toEqual(['1|warning|TRUNCATE', '2|warning|MAX_EVENTS', '4|warning|SHOULD_LINEMERGE']);
    expect([...editorSet].sort()).toEqual([...engine].sort());
  });

  it.each([
    ['KV_MODE = multi:cisco', 0],
    ['KV_MODE = MULTI:cisco', 0],
    ['KV_MODE = bogus', 1],
    ['TRUNCATE = 1.5', 1],
    ['TRUNCATE = 1e3', 1],
    ['TRUNCATE = 0x10', 1],
    ['TRUNCATE = Infinity', 1],
    ['MAX_EVENTS = -5', 1],
    ['MAX_TIMESTAMP_LOOKAHEAD = -1', 0],
    ['TRUNCATE = +3', 0],
  ])('%s: one verdict in both places (%i finding)', (conf, count) => {
    const { engine, editor: editorSet } = both(`[st]\n${conf}\n`, 'props.conf');
    expect(engine.size).toBe(count);
    expect(editorSet.size).toBe(count);
  });
});
