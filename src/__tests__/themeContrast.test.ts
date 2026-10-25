import { describe, it, expect } from 'vitest';
import { FIELD_COLORS } from '../components/preview/tabs/shared/fieldColors';

const read = (path: string) =>
  (
    globalThis as unknown as {
      process: { getBuiltinModule: (id: 'node:fs') => { readFileSync(path: string, encoding: 'utf8'): string } };
    }
  ).process
    .getBuiltinModule('node:fs')
    .readFileSync(path, 'utf8');
// Read from disk: under vitest a CSS import, `?raw` too, is an empty string.
const css = read('src/index.css');
const monaco = read('src/components/editor/splunkMonacoSetup.ts');

// The theme tokens' contrast, read from index.css itself (#688), so a token
// edited later is held to the same bar it was chosen to: WCAG 2.2's 4.5:1 for
// text and 3:1 for a control's boundary and the focus ring (1.4.3, 1.4.11).
// The ratios are WCAG's relative-luminance formula.

type Tokens = Record<string, string>;

function block(selector: string): Tokens {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map(([, k = '', v = '']) => [k, v]),
  );
}

const channel = (hex: string, i: number) => {
  const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** `fg` at `pct` over `bg`: what `tint()` and a `/10` utility paint. */
const over = (bg: string, fg: string, pct: number) =>
  `#${[0, 1, 2]
    .map((i) => {
      const [b, f] = [bg, fg].map((h) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)) as [number, number];
      return Math.round(b + (f - b) * pct)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;

const SURFACES = ['bg-primary', 'bg-secondary', 'bg-elevated', 'bg-tertiary'];

describe.each([
  ['light', block(':root'), 'LIGHT_THEME'],
  ['dark', block('.dark'), 'DARK_THEME'],
] as const)('the %s theme', (theme, t, monacoTheme) => {
  const failures = (pairs: [string, string, string, number][]) =>
    pairs
      .filter(([, fg, bg, min]) => ratio(fg, bg) < min)
      .map(([label, fg, bg]) => `${label}: ${ratio(fg, bg).toFixed(2)}`);
  const get = (name: string) => {
    const value = t[name];
    if (!value) throw new Error(`--color-${name} is not a six-digit hex in index.css`);
    return value;
  };

  it('reads every token the checks need', () => {
    for (const name of [...SURFACES, 'text-primary', 'accent', 'border-control', 'text-on-accent'])
      expect(get(name)).toMatch(/^#/);
  });

  it('gives every text colour 4.5:1 on every surface, and primary text 7:1', () => {
    const pairs = SURFACES.flatMap((s) => [
      [`text-primary on ${s}`, get('text-primary'), get(s), 7] as [string, string, string, number],
      ...['text-secondary', 'text-muted'].map(
        (c) => [`${c} on ${s}`, get(c), get(s), 4.5] as [string, string, string, number],
      ),
    ]);
    expect(failures(pairs)).toEqual([]);
  });

  it('gives the accent and status colours 4.5:1 as text on every surface and on their own /10 tint', () => {
    const pairs = ['accent', 'error', 'warning', 'success'].flatMap((c) =>
      SURFACES.flatMap((s) => [
        [`${c} on ${s}`, get(c), get(s), 4.5] as [string, string, string, number],
        [`${c} on its /10 over ${s}`, get(c), over(get(s), get(c), 0.1), 4.5] as [string, string, string, number],
      ]),
    );
    expect(failures(pairs)).toEqual([]);
  });

  it('gives text on an accent or error fill 4.5:1', () => {
    expect(
      failures([
        ['text-on-accent on accent', get('text-on-accent'), get('accent'), 4.5],
        ['text-on-accent on accent-hover', get('text-on-accent'), get('accent-hover'), 4.5],
        ['text-on-error on error', get('text-on-error'), get('error'), 4.5],
      ]),
    ).toEqual([]);
  });

  it('gives the focus ring 3:1 on every surface', () => {
    const pairs = SURFACES.map(
      (s) => [`accent (focus ring) on ${s}`, get('accent'), get(s), 3] as [string, string, string, number],
    );
    expect(failures(pairs)).toEqual([]);
  });

  // Not on bg-tertiary: that is a hover or pressed fill, never the surface
  // around a control. A control filled with it (the page box) has the fill
  // inside its border, and the border's contrast is with what is outside.
  it("gives a control's border 3:1 on the surfaces a control sits on, and not much more (#695)", () => {
    const surfaces = ['bg-primary', 'bg-secondary', 'bg-elevated'];
    const pairs = surfaces.map(
      (s) => [`border-control on ${s}`, get('border-control'), get(s), 3] as [string, string, string, number],
    );
    expect(failures(pairs)).toEqual([]);
    // The weakest pair sets how dark the border is: keep it near the floor.
    expect(Math.min(...surfaces.map((s) => ratio(get('border-control'), get(s))))).toBeLessThan(3.3);
  });
  it('gives every field-highlight colour 4.5:1 on the panes and on its own tint', () => {
    const pairs = FIELD_COLORS[theme].flatMap((c) =>
      ['bg-primary', 'bg-secondary', 'bg-elevated'].flatMap((s) => [
        [`field ${c} on ${s}`, c, get(s), 4.5] as [string, string, string, number],
        // tint(color, 13) is the strongest a field row is filled with.
        [`field ${c} on its 13% tint over ${s}`, c, over(get(s), c, 0.13), 4.5] as [string, string, string, number],
      ]),
    );
    expect(failures(pairs)).toEqual([]);
  });

  it('gives every Monaco syntax colour 4.5:1 on the editor and its current line', () => {
    const start = monaco.indexOf(`const ${monacoTheme}`);
    const source = monaco.slice(start, monaco.indexOf('\n};', start));
    const colour = (key: string) =>
      `#${new RegExp(`'${key.replace('.', '\\.')}': '#([0-9a-f]{6})`).exec(source)?.[1] ?? ''}`;
    const backgrounds = [colour('editor.background'), colour('editor.lineHighlightBackground')];
    expect(backgrounds[0]).toBe(get('bg-elevated'));
    const rules = [...source.matchAll(/token: '([^']+)', foreground: '([0-9a-f]{6})'/g)];
    expect(rules.length).toBeGreaterThan(10);
    const pairs = rules.flatMap(([, token = '', fg = '']) =>
      backgrounds.map((bg) => [`${token} on ${bg}`, `#${fg}`, bg, 4.5] as [string, string, string, number]),
    );
    expect(failures(pairs)).toEqual([]);
  });
});
