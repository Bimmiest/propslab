// The code in docs/engine.md is checked against the engine (#519): every fenced
// `ts` block is type-checked with the TypeScript compiler as if it sat at the
// repository root, so a renamed export, a changed signature or a stale import
// path fails here rather than in a reader's editor. The runPipeline signature
// line is compared to the real parameter list, and the layered-conf example is
// executed, because a type-correct example that does the wrong thing is worse
// than none.
//
// The compiler API is used through `ts.sys` and Vite's `?raw` glob rather than
// node:fs, because the app's tsconfig has no Node types (see docs.test.ts).
import { describe, it, expect } from 'vitest';
import * as tsNamespace from 'typescript';
import { runPipeline } from '../engine/pipeline';

// typescript is CommonJS: depending on the loader its API is on the namespace
// or on `default`.
const ts: typeof tsNamespace = (tsNamespace as unknown as { default?: typeof tsNamespace }).default ?? tsNamespace;

const engineDoc =
  Object.values(import.meta.glob<string>('/docs/engine.md', { query: '?raw', import: 'default', eager: true }))[0] ??
  '';

interface Block {
  /** 1-based line of the first line of code in engine.md. */
  line: number;
  code: string;
}

function tsBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^```ts\s*$/.test(lines[i] ?? '')) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && !/^```\s*$/.test(lines[end] ?? '')) end++;
    blocks.push({ line: start + 1, code: lines.slice(start, end).join('\n') });
    i = end;
  }
  return blocks;
}

/**
 * Names the examples use without defining, standing in for the reader's own
 * data (`raw`, the conf texts) and Node's helpers. A new free name in the doc
 * fails the type-check with "Cannot find name"; declare it here.
 */
const AMBIENT = `
import type { EventMetadata as AmbientMetadata } from './src/engine/types';
declare global { interface ImportMeta { url: string } }
declare const rawData: string;
declare const raw: string;
declare const metadata: AmbientMetadata;
declare const defaultProps: string;
declare const localProps: string;
declare const defaultTransforms: string;
declare const localTransforms: string;
declare const wasmUrl: string;
declare function readFileSync(path: string): Uint8Array;
declare function createRequire(url: string): { resolve(id: string): string };
`;
const AMBIENT_LINES = AMBIENT.split('\n').length - 1;

function typeCheck(blocks: Block[]): string[] {
  const root = ts.sys.getCurrentDirectory().replace(/\\/g, '/');
  const virtual = new Map(blocks.map((b, i) => [`${root}/docs-engine-example-${i}.ts`, AMBIENT + b.code]));
  const options: tsNamespace.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    strict: true,
    noUncheckedIndexedAccess: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const text = virtual.get(name);
    return text === undefined
      ? getSourceFile.call(host, name, languageVersion, ...rest)
      : ts.createSourceFile(name, text, languageVersion);
  };
  host.fileExists = (name) => virtual.has(name) || fileExists.call(host, name);
  host.readFile = (name) => virtual.get(name) ?? readFile.call(host, name);

  const program = ts.createProgram([...virtual.keys()], options, host);
  const problems: string[] = [];
  for (const [index, name] of [...virtual.keys()].entries()) {
    const file = program.getSourceFile(name);
    if (!file) throw new Error(`${name} was not loaded`);
    for (const d of [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]) {
      const at = d.start === undefined ? 0 : file.getLineAndCharacterOfPosition(d.start).line + 1 - AMBIENT_LINES;
      const docLine = (blocks[index]?.line ?? 0) + at - 1;
      problems.push(`docs/engine.md:${docLine}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')} (TS${d.code})`);
    }
  }
  return problems;
}

describe('docs/engine.md examples', () => {
  const blocks = tsBlocks(engineDoc);

  it('has the examples this test expects', () => {
    // A guard against the extraction quietly matching nothing.
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(blocks.some((b) => b.code.includes('initRegexEngineSync'))).toBe(true);
  });

  it('type-check against the engine', () => {
    expect(typeCheck(blocks)).toEqual([]);
  });

  it('documents runPipeline with its real parameter names', () => {
    // The signature line is a `text` block (it is not valid TypeScript: `options?`).
    const documented = /^runPipeline\(([^)]*)\)$/m
      .exec(engineDoc)?.[1]
      ?.split(',')
      .map((p) => p.trim());
    const declaration = ts.sys.readFile(`${ts.sys.getCurrentDirectory()}/src/engine/pipeline.ts`) ?? '';
    const actual = /export function runPipeline\(([^)]*)\)/
      .exec(declaration)?.[1]
      ?.split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map((p) => p.replace(/^(\w+\??):.*$/s, '$1'));
    expect(actual, 'runPipeline declaration not found').toBeDefined();
    expect(documented).toEqual(actual);
  });

  it('runs the layered-conf example, whose local layer overrides per attribute', () => {
    const block = blocks.find((b) => b.code.includes('layer:'));
    expect(block, 'no layered example found').toBeDefined();
    // Imports are satisfied by the scope below (the type-check above already resolved them).
    const code = (block?.code ?? '').replace(/^import .*$/gm, '');
    const js = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;

    let output: ReturnType<typeof runPipeline> | undefined;
    const spy: typeof runPipeline = (...args) => (output = runPipeline(...args));
    const scope = {
      runPipeline: spy,
      raw: 'alice 42',
      metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      defaultProps: '[st]\nSHOULD_LINEMERGE = false\nEXTRACT-name = ^(?<name>\\w+)',
      localProps: '[st]\nEXTRACT-num = (?<num>\\d+)',
      defaultTransforms: '',
      localTransforms: '',
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the documented snippet is the test
    const run = new Function(...Object.keys(scope), js) as (...values: unknown[]) => void;
    run(...Object.values(scope));

    expect(output?.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    const fields = output?.result.events[0]?.fields;
    // default/ supplies one EXTRACT and local/ another; neither replaces the other.
    expect(fields?.['name']).toBe('alice');
    expect(fields?.['num']).toBe('42');
  });
});
