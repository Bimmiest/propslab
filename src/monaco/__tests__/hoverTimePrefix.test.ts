// ---------------------------------------------------------------------------
// hoverTimePrefix.test.ts
// The TIME_FORMAT hover previews the format against the TIME_PREFIX the
// PIPELINE would use for that stanza (#502): read through parseConf, so order
// within the stanza does not matter, a continued value is joined, [default] is
// inherited and the last definition wins. buildTimeFormatPreview is replaced by
// a spy, since what matters here is what the hover hands it.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Position, languages } from 'monaco-editor';
import { createHoverProvider, firstNonBlankLine } from '../splunkConfHover';
import { fakeModel } from '../../test/fakeModel';
import { fcSeed } from '../../test/fcSeed';
import { useAppStore } from '../../store/useAppStore';

const build = vi.hoisted(() => vi.fn());
vi.mock('../timeFormatPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../timeFormatPreview')>()),
  buildTimeFormatPreview: build,
}));

beforeEach(() => {
  build.mockReset();
  build.mockResolvedValue(null);
  useAppStore.getState().setRawData('');
});

/** Hover the value of the directive on `lineNumber` of `conf`; the options and format the preview was built with. */
async function previewFor(conf: string, lineNumber: number) {
  build.mockClear();
  const line = fakeModel(conf).getLineContent(lineNumber);
  const result = createHoverProvider('props.conf').provideHover(
    fakeModel(conf),
    { lineNumber, column: line.indexOf('=') + 3 } as Position,
    { isCancellationRequested: false } as never,
    undefined,
  );
  await Promise.resolve(result as languages.Hover | null | undefined);
  if (build.mock.calls.length === 0) return undefined;
  const [format, options] = build.mock.calls[0] as [string, { timePrefix?: string; sampleLine?: string }];
  return { format, timePrefix: options.timePrefix, sampleLine: options.sampleLine };
}

describe('TIME_FORMAT hover reads TIME_PREFIX as the engine does (#502)', () => {
  it('finds a TIME_PREFIX defined BELOW the TIME_FORMAT', async () => {
    const conf = '[st]\nTIME_FORMAT = %Y-%m-%d\nTIME_PREFIX = ts=\n';
    expect(await previewFor(conf, 2)).toMatchObject({ format: '%Y-%m-%d', timePrefix: 'ts=' });
  });

  it('joins a continued TIME_PREFIX instead of passing its first fragment with the backslash', async () => {
    const conf = '[st]\nTIME_PREFIX = ts=\\\n\\d+;\nTIME_FORMAT = %Y-%m-%d\n';
    expect((await previewFor(conf, 4))?.timePrefix).toBe('ts=\\d+;');
  });

  it('passes the whole of a continued TIME_FORMAT, not its first physical line', async () => {
    const conf = '[st]\nTIME_PREFIX = ts=\nTIME_FORMAT = %Y-%m-%d\\\n %H:%M:%S\n';
    expect((await previewFor(conf, 3))?.format.trim()).toBe('%Y-%m-%d %H:%M:%S');
  });

  it('takes the last definition of TIME_PREFIX in the stanza', async () => {
    const conf = '[st]\nTIME_PREFIX = old=\nTIME_FORMAT = %Y\nTIME_PREFIX = new=\n';
    expect((await previewFor(conf, 3))?.timePrefix).toBe('new=');
  });

  it('inherits TIME_PREFIX from [default], and the stanza overrides it', async () => {
    const conf = '[default]\nTIME_PREFIX = dflt=\n\n[a]\nTIME_FORMAT = %Y\n\n[b]\nTIME_PREFIX = own=\nTIME_FORMAT = %Y\n';
    expect((await previewFor(conf, 5))?.timePrefix).toBe('dflt=');
    expect((await previewFor(conf, 9))?.timePrefix).toBe('own=');
  });

  it('does not borrow a TIME_PREFIX from another stanza', async () => {
    const conf = '[a]\nTIME_PREFIX = a=\n\n[b]\nTIME_FORMAT = %Y\n';
    expect((await previewFor(conf, 5))?.timePrefix).toBeUndefined();
  });

  it('merges a repeated stanza the way the pipeline does', async () => {
    const conf = '[a]\nTIME_FORMAT = %Y\n\n[a]\nTIME_PREFIX = later=\n';
    expect((await previewFor(conf, 2))?.timePrefix).toBe('later=');
  });

  it('treats an empty TIME_PREFIX as unset', async () => {
    const conf = '[st]\nTIME_PREFIX =\nTIME_FORMAT = %Y\n';
    expect((await previewFor(conf, 3))?.timePrefix).toBeUndefined();
  });

  it('gives no preview on the continuation line of another directive', async () => {
    const conf = '[st]\nEXTRACT-a = (?<x>a)\\\nTIME_FORMAT = %Y\n';
    expect(await previewFor(conf, 3)).toBeUndefined();
  });

  it('previews against the first non-blank line of the loaded data', async () => {
    useAppStore.getState().setRawData('\n  \nfirst line\nsecond\n');
    expect((await previewFor('[st]\nTIME_FORMAT = %Y\n', 2))?.sampleLine).toBe('first line');
  });
});

describe('firstNonBlankLine', () => {
  it.each([
    ['', undefined],
    ['\n\n  \n', undefined],
    ['one\ntwo', 'one'],
    ['\n\nlate', 'late'],
    ['   \n\t\n x \n', ' x '],
    ['only', 'only'],
    ['a\r\nb', 'a\r'],
  ])('%j -> %j', (raw, expected) => {
    expect(firstNonBlankLine(raw)).toBe(expected);
  });

  it('agrees with splitting the whole log, on generated text', async () => {
    const fc = (await import('fast-check')).default;
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', ' ', '\n', '\t', 'bc', '\r')), (parts) => {
        const raw = parts.join('');
        expect(firstNonBlankLine(raw)).toBe(raw.split('\n').find((l) => l.trim() !== ''));
      }),
      { seed: fcSeed(502) },
    );
  });
});
