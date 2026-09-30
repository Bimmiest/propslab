import { beforeAll, describe, expect, it } from 'vitest';
import { parseConf } from '../../../../src/engine/parser/confParser';
import type { ConfDirective } from '../../../../src/engine/types';
import { directivePatterns } from '../directivePatterns';
import { collectRegexSuspects } from '../suspects';
import { lintRegexDirectives } from '../regexLint';
import { regexEngineModule } from '../regexEngine';

const directive = (line: string, file: 'props.conf' | 'transforms.conf' = 'props.conf'): ConfDirective => {
  const dir = parseConf(`[s]\n${line}`, file).stanzas[0]?.directives[0];
  if (!dir) throw new Error(`no directive in ${line}`);
  return dir;
};
const patterns = (line: string, file: 'props.conf' | 'transforms.conf' = 'props.conf') =>
  directivePatterns(directive(line, file), file);

describe('directivePatterns (#517)', () => {
  it("reads an EXTRACT's pattern without its `in <field>` suffix", () => {
    expect(patterns('EXTRACT-a = (?<a>\\d+) in src')).toEqual([{ pattern: '(?<a>\\d+)' }]);
    expect(patterns('EXTRACT-a = (?<a>\\d+)')).toEqual([{ pattern: '(?<a>\\d+)' }]);
  });

  it("reads an s/// SEDCMD's regex, and none from y/// or a value that is not sed", () => {
    expect(patterns('SEDCMD-m = s/\\d{4}/xxxx/g')).toEqual([{ pattern: '\\d{4}' }]);
    expect(patterns('SEDCMD-m = s#a\\#b#c#')).toEqual([{ pattern: 'a\\#b' }]);
    expect(patterns('SEDCMD-t = y/abc/xyz/')).toEqual([]);
    expect(patterns('SEDCMD-x = not sed')).toEqual([]);
    expect(patterns('SEDCMD-x = s/unclosed')).toEqual([]);
  });

  it('finds each literal regex an eval expression passes to match(), replace() or mvfind()', () => {
    expect(
      patterns('EVAL-x = if(match(f, "a+b"), replace(g, "c(d)", "x"), mvfind(h, "e")) . lower(f)'),
    ).toEqual([
      { pattern: 'a+b', fn: 'match' },
      { pattern: 'c(d)', fn: 'replace' },
      { pattern: 'e', fn: 'mvfind' },
    ]);
    // Nested anywhere: operators, not, in, case-insensitive names.
    expect(
      patterns('EVAL-y = NOT MATCH(f, "p1") AND -len(replace(g, "p2", "")) > 1 OR f IN (match(g, "p3"))'),
    ).toEqual([
      { pattern: 'p1', fn: 'match' },
      { pattern: 'p2', fn: 'replace' },
      { pattern: 'p3', fn: 'match' },
    ]);
    // A regex from a field is not knowable; like() builds its own; an
    // expression that does not parse runs nothing.
    expect(patterns('EVAL-z = match(f, g) . like(f, "a%")')).toEqual([]);
    expect(patterns('EVAL-z = match(f, "a"')).toEqual([]);
  });

  it('reads INGEST_EVAL assignment by assignment, and STOP_PROCESSING_IF', () => {
    expect(patterns('INGEST_EVAL = a=match(x, "p1"), b:=replace(y, "p,2", "z")', 'transforms.conf')).toEqual([
      { pattern: 'p1', fn: 'match' },
      { pattern: 'p,2', fn: 'replace' },
    ]);
    expect(patterns('STOP_PROCESSING_IF = match(_raw, "p3")', 'transforms.conf')).toEqual([
      { pattern: 'p3', fn: 'match' },
    ]);
  });

  it('takes any other regex-typed value whole, and nothing from other directives', () => {
    expect(patterns('LINE_BREAKER =  ([\\r\\n]+) ')).toEqual([{ pattern: '([\\r\\n]+)' }]);
    expect(patterns('REGEX = (x)', 'transforms.conf')).toEqual([{ pattern: '(x)' }]);
    expect(patterns('TRUNCATE = 100')).toEqual([]);
    expect(patterns('EXTRACT-e =   ')).toEqual([]);
  });
});

describe('the suspect list and validate agree on the patterns (#517)', () => {
  // Compiling needs the PCRE2 module, which the worker gets from the server.
  beforeAll(() => {
    regexEngineModule();
  });

  it('lists, and lints, the same pattern for every form', () => {
    const props = [
      '[st]',
      'EXTRACT-in = (?<a>( in src',
      'SEDCMD-s = s/[/x/g',
      'EVAL-e = replace(f, "(unclosed", "x")',
      'LINE_BREAKER = ([\\r\\n]+',
    ].join('\n');
    const transforms = '[t]\nINGEST_EVAL = a=match(x, "[z")';
    const suspects = collectRegexSuspects(props, transforms);
    const byKey = Object.fromEntries(suspects.map((s) => [s.key, s]));
    expect(byKey['EXTRACT-in']?.pattern).toBe('(?<a>(');
    expect(byKey['SEDCMD-s']?.pattern).toBe('[');
    expect(byKey['EVAL-e']).toMatchObject({ pattern: '(unclosed', via: 'replace()' });
    expect(byKey.INGEST_EVAL).toMatchObject({ pattern: '[z', via: 'match()', file: 'transforms.conf' });

    const lint = lintRegexDirectives(parseConf(props, 'props.conf'), parseConf(transforms, 'transforms.conf'));
    const linted = new Map(lint.map((d) => [d.directiveKey, d.message]));
    for (const suspect of suspects) {
      expect(linted.get(suspect.key), suspect.key).toBeDefined();
    }
    expect(linted.get('EXTRACT-in')).toMatch(/^EXTRACT-in = \(\?<a>\( — /);
    expect(linted.get('EVAL-e')).toMatch(/^EVAL-e: replace\(\) pattern "\(unclosed" could not be compiled/);
    expect(linted.get('INGEST_EVAL')).toMatch(/match\(\) pattern "\[z" could not be compiled/);
  });
});
