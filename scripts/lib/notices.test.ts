import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';
import { noticeFiles, noticesPlugin } from './notices.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('noticeFiles (#892)', () => {
  it('serves the root NOTICE and the licences that it names', () => {
    const files = noticeFiles(ROOT);
    expect(files.map((f) => f.fileName)).toEqual(['NOTICE.txt', 'LICENSE-OCSF.txt', 'LICENCE-PCRE2.txt']);
    expect(files[0]?.from).toBe(`${ROOT}NOTICE`);
    for (const { from } of files) expect(readFileSync(from, 'utf8').length).toBeGreaterThan(0);
    expect(readFileSync(files[1]!.from, 'utf8')).toMatch(/Apache License\s+Version 2\.0/);
  });

  it('names each file that the served NOTICE refers a reader to', () => {
    const notice = readFileSync(`${ROOT}NOTICE`, 'utf8');
    expect(notice).toContain('LICENSE-OCSF.txt');
    expect(notice).toContain('LICENCE-PCRE2.txt');
  });
});

describe('noticesPlugin', () => {
  const files = noticeFiles(ROOT);

  it('emits each file into the build with the bytes of its source', () => {
    const emitFile = vi.fn();
    const plugin = noticesPlugin(files) as Plugin & { generateBundle: (this: unknown) => void };
    plugin.generateBundle.call({ emitFile });
    expect(emitFile).toHaveBeenCalledTimes(files.length);
    for (const [i, { fileName, from }] of files.entries()) {
      expect(emitFile.mock.calls[i]?.[0]).toEqual({ type: 'asset', fileName, source: readFileSync(from) });
    }
  });

  it('serves each file from the dev server as text, and passes other requests on', () => {
    let handler: (req: { url: string }, res: unknown, next: () => void) => void = () => undefined;
    const plugin = noticesPlugin(files) as Plugin & { configureServer: (server: unknown) => void };
    plugin.configureServer({ middlewares: { use: (h: typeof handler) => (handler = h) } });

    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    handler({ url: '/NOTICE.txt' }, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
    expect(res.end).toHaveBeenCalledWith(readFileSync(`${ROOT}NOTICE`));
    expect(next).not.toHaveBeenCalled();

    handler({ url: '/index.html' }, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
