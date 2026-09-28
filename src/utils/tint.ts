/**
 * A translucent tint of a colour for backgrounds. color-mix rather than an
 * appended alpha byte (`color + '20'`), which only works on a six-digit hex:
 * on a `var(--color-…)` it yields an invalid value the browser drops.
 */
export const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
