import { describe, it, expect, vi } from 'vitest';
import { run } from '../../scripts/drop-format-only.mjs';

// The filter mutation.yml runs on a PR's changed engine files. Telling
// formatting and comments from code is formatOnly.test.ts's; this is the
// command around it: its arguments, which files it keeps, and what it says.
const source = 'export const x = 1;\n';
const texts: Record<string, { before: string | null; after: string }> = {
  'src/new.ts': { before: null, after: source },
  'src/reformatted.ts': { before: 'export const   x =\n  1;\n', after: source },
  'src/commented.ts': { before: `// old\n${source}`, after: `// new\n${source}` },
  'src/changed.ts': { before: source, after: 'export const x = 2;\n' },
};

async function runWith(args: string[]) {
  const show = vi.fn((_ref: string, file: string) => texts[file]?.before ?? null);
  const read = vi.fn((file: string) => texts[file]?.after ?? '');
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { show, read, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err, show, read };
}

describe('drop-format-only', () => {
  it('needs a base ref, and says how to call it', async () => {
    const { code, out, err, show } = await runWith([]);
    expect(code).toBe(2);
    expect(err).toEqual(['Usage: node scripts/drop-format-only.mjs <base-ref> <file,file,...>']);
    expect(out).toEqual([]);
    expect(show).not.toHaveBeenCalled();
  });

  it('prints an empty list for no files, which mutation.yml reads as nothing to mutate', async () => {
    expect(await runWith(['origin/main'])).toMatchObject({ code: 0, out: [''], err: [] });
    expect(await runWith(['origin/main', ''])).toMatchObject({ code: 0, out: [''], err: [] });
  });

  it('reads each file at the base ref it is given, skipping empty entries', async () => {
    const { show } = await runWith(['origin/main', ',src/changed.ts,,src/new.ts,']);
    expect(show.mock.calls).toEqual([
      ['origin/main', 'src/changed.ts'],
      ['origin/main', 'src/new.ts'],
    ]);
  });

  it('keeps a file that is new on the branch without reading it', async () => {
    const { out, err, read } = await runWith(['origin/main', 'src/new.ts']);
    expect(out).toEqual(['src/new.ts']);
    expect(err).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps a file whose code changed', async () => {
    expect(await runWith(['origin/main', 'src/changed.ts'])).toMatchObject({ out: ['src/changed.ts'], err: [] });
  });

  it('drops a reformatted file', async () => {
    expect(await runWith(['origin/main', 'src/reformatted.ts'])).toMatchObject({
      out: [''],
      err: ['Formatting or comment change only, not mutated: `src/reformatted.ts`'],
    });
  });

  it('drops a file whose comments alone changed', async () => {
    expect(await runWith(['origin/main', 'src/commented.ts'])).toMatchObject({
      out: [''],
      err: ['Formatting or comment change only, not mutated: `src/commented.ts`'],
    });
  });

  it('prints the kept files in their order, comma-separated, and names each dropped one', async () => {
    const { code, out, err } = await runWith([
      'origin/main',
      'src/changed.ts,src/reformatted.ts,src/new.ts,src/commented.ts',
    ]);
    expect(code).toBe(0);
    expect(out).toEqual(['src/changed.ts,src/new.ts']);
    expect(err).toEqual([
      'Formatting or comment change only, not mutated: `src/reformatted.ts`',
      'Formatting or comment change only, not mutated: `src/commented.ts`',
    ]);
  });
});
