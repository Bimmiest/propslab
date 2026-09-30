import { describe, it, expect } from 'vitest';
import { FORBIDDEN, checkEntryGraph, resolveImport, staticImports } from '../../scripts/lib/entryGraph.mjs';

// The walk behind scripts/check-entry-graph.mjs (#467): the startup path must
// not reach the Monaco chunk. Reading dist/ is the script's own.
describe('staticImports', () => {
  it('reads the static forms a minifier writes', () => {
    const source =
      'import{a as b}from"./x.js";import"./side.js";export{c}from"./y.js";export*from"./z.js";import d from"./d.js";';
    expect(staticImports(source)).toEqual(['./x.js', './side.js', './y.js', './z.js', './d.js']);
  });

  it('does not follow a dynamic import(), which is the lazy path', () => {
    expect(staticImports('const m=()=>import("./lazy.js");import("./also-lazy.js")')).toEqual([]);
  });

  it('leaves out a package specifier, which is not a file of the build', () => {
    expect(staticImports('import React from"react";import{x}from"./local.js"')).toEqual(['./local.js']);
  });

  it('reads the spaced forms of unminified output too', () => {
    expect(staticImports("import { a, b } from './x.js';\nexport * from '../up.js';")).toEqual(['./x.js', '../up.js']);
  });
});

describe('resolveImport', () => {
  it('resolves against the importing file, from the dist root', () => {
    expect(resolveImport('assets/index-a1.js', './vendor-b2.js')).toBe('assets/vendor-b2.js');
    expect(resolveImport('assets/sub/x.js', '../y.js')).toBe('assets/y.js');
  });

  it('takes a leading slash as the dist root', () => {
    expect(resolveImport('assets/index-a1.js', '/assets/other.js')).toBe('assets/other.js');
  });
});

describe('FORBIDDEN', () => {
  it('matches the Monaco chunk and its stylesheet, hashed, and nothing that only mentions it', () => {
    expect(FORBIDDEN.test('assets/monaco-editor-BqX1w2Zy.js')).toBe(true);
    expect(FORBIDDEN.test('/assets/monaco-editor-BqX1w2Zy.css')).toBe(true);
    expect(FORBIDDEN.test('assets/editor.worker-BqX1w2Zy.js')).toBe(false);
    expect(FORBIDDEN.test('assets/my-monaco-editor-BqX1w2Zy.js')).toBe(false);
  });
});

describe('checkEntryGraph', () => {
  const page = (...tags: string[]) => `<!doctype html><head>${tags.join('')}</head><body></body>`;
  const entry = '<script type="module" src="/assets/index-a1.js"></script>';
  const files = (build: Record<string, string>) => (file: string) => build[file] ?? null;

  it('passes a startup path that keeps Monaco behind a dynamic import', () => {
    const { problems, seen } = checkEntryGraph(
      page(entry, '<link rel="modulepreload" href="/assets/vendor-b2.js">'),
      files({
        'assets/index-a1.js': 'import{r}from"./vendor-b2.js";const editors=()=>import("./monaco-editor-Zz9.js");',
        'assets/vendor-b2.js': 'export const r=1;',
      }),
    );
    expect(problems).toEqual([]);
    expect(seen).toEqual(['assets/index-a1.js', 'assets/vendor-b2.js']);
  });

  it('fails when the document itself preloads the Monaco chunk or its stylesheet', () => {
    const { problems } = checkEntryGraph(
      page(
        entry,
        '<link rel="modulepreload" href="/assets/monaco-editor-BqX1w2Zy.js">',
        '<link rel="stylesheet" href="/assets/monaco-editor-BqX1w2Zy.css">',
      ),
      files({ 'assets/index-a1.js': '', 'assets/monaco-editor-BqX1w2Zy.js': '' }),
    );
    expect(problems).toContain('index.html has a modulepreload for /assets/monaco-editor-BqX1w2Zy.js');
    expect(problems).toContain('index.html has a stylesheet for /assets/monaco-editor-BqX1w2Zy.css');
  });

  it('fails when the entry statically imports it (#467)', () => {
    const { problems } = checkEntryGraph(
      page(entry),
      files({ 'assets/index-a1.js': 'import{h}from"./monaco-editor-BqX1w2Zy.js";' }),
    );
    expect(problems).toEqual(['assets/index-a1.js statically imports assets/monaco-editor-BqX1w2Zy.js']);
  });

  it('follows the closure: a chunk the entry imports may not import it either', () => {
    const { problems, seen } = checkEntryGraph(
      page(entry),
      files({
        'assets/index-a1.js': 'import"./middle-b2.js";',
        'assets/middle-b2.js': 'export*from"./monaco-editor-BqX1w2Zy.js";',
      }),
    );
    expect(problems).toEqual(['assets/middle-b2.js statically imports assets/monaco-editor-BqX1w2Zy.js']);
    expect(seen).toEqual(['assets/index-a1.js', 'assets/middle-b2.js']);
  });

  it('reads a chunk once when two import it, and survives a cycle', () => {
    const { problems, seen } = checkEntryGraph(
      page(entry),
      files({
        'assets/index-a1.js': 'import"./a-b2.js";import"./b-b2.js";',
        'assets/a-b2.js': 'import"./shared-b2.js";',
        'assets/b-b2.js': 'import"./shared-b2.js";',
        'assets/shared-b2.js': 'import"./a-b2.js";',
      }),
    );
    expect(problems).toEqual([]);
    expect(seen).toEqual(['assets/a-b2.js', 'assets/b-b2.js', 'assets/index-a1.js', 'assets/shared-b2.js']);
  });

  it('reports a file the build does not have, and who asked for it', () => {
    const { problems } = checkEntryGraph(page(entry), files({ 'assets/index-a1.js': 'import"./missing-b2.js";' }));
    expect(problems).toEqual(['assets/index-a1.js refers to assets/missing-b2.js, which is not in the build']);
  });

  it('reports a script the document names that the build lacks', () => {
    const { problems } = checkEntryGraph(page(entry), files({}));
    expect(problems).toEqual(['index.html refers to assets/index-a1.js, which is not in the build']);
  });
});
