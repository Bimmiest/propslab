// One palette per theme, in the same hue order so a field keeps its hue across a
// toggle. The colours are drawn as TEXT, on the pane surfaces and on their own
// ~20% tint, so no single set can serve both: the light set is Tailwind's
// -700/-800 shades and the dark set its -300s, each ≥4.5:1 in every such
// pairing. Callers tint them with tint() (utils/tint.ts).
//
// Typed as non-empty so `fieldColorAt` has an element it can always fall back
// on. Every consumer cycles through this palette by index, and a palette with no
// colours in it would have no meaningful answer to give them.
export const FIELD_COLORS = {
  light: [
    '#1d4ed8',
    '#991b1b',
    '#166534',
    '#92400e',
    '#6d28d9',
    '#9d174d',
    '#155e75',
    '#9a3412',
    '#115e59',
    '#4338ca',
    '#7e22ce',
    '#3f6212',
  ],
  dark: [
    '#93c5fd',
    '#fca5a5',
    '#86efac',
    '#fcd34d',
    '#c4b5fd',
    '#f9a8d4',
    '#67e8f9',
    '#fdba74',
    '#5eead4',
    '#b4befe',
    '#d8b4fe',
    '#bef264',
  ],
} as const satisfies Record<'light' | 'dark', readonly [string, ...string[]]>;

/**
 * The colour for the `index`-th distinct field, cycling once the palette runs
 * out. The modulo keeps the index in range; the fallback only exists to say so
 * in a way the compiler can check.
 */
export function fieldColorAt(index: number, theme: 'light' | 'dark'): string {
  const palette = FIELD_COLORS[theme];
  return palette[index % palette.length] ?? palette[0];
}
