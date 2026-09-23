// ---------------------------------------------------------------------------
// directiveRegistry.test.ts
// The registry's assembly from the data files under registry/ (#301), and the
// two per-file listings built from it.
//
// The entries were one array before the split, and the order they were written
// in is the order completion and the dictionary present them — so what matters
// here is that assembling them loses nothing and keeps that order.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { getAllDirectives, getDirectivesByCategory, getDirectivesForFile } from '../directiveRegistry';
import { PROPS_ADDITIONAL, PROPS_CORE, PROPS_MISC } from '../registry/propsDirectives';
import { TRANSFORMS_ADDITIONAL, TRANSFORMS_CORE } from '../registry/transformsDirectives';
import { PROPS_SPEC_COMPLETENESS } from '../registry/propsSpecDirectives';
import { TRANSFORMS_SPEC_COMPLETENESS } from '../registry/transformsSpecDirectives';

const SECTIONS = [
  PROPS_CORE,
  TRANSFORMS_CORE,
  PROPS_ADDITIONAL,
  TRANSFORMS_ADDITIONAL,
  PROPS_MISC,
  PROPS_SPEC_COMPLETENESS,
  TRANSFORMS_SPEC_COMPLETENESS,
];

const ident = (d: { key: string; appliesTo: string }) => `${d.appliesTo}:${d.key}`;

describe('registry assembly', () => {
  it('holds every entry of every data file, in the order they were written', () => {
    expect(getAllDirectives().map(ident)).toEqual(SECTIONS.flat().map(ident));
  });

  it('attaches a support level to every entry', () => {
    for (const d of getAllDirectives()) expect(d.support, d.key).toMatch(/^(simulated|documented|ignored)$/);
  });
});

describe('getDirectivesForFile', () => {
  it.each(['props.conf', 'transforms.conf'] as const)('lists %s entries and the ones that apply to both', (file) => {
    const listed = getDirectivesForFile(file);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((d) => d.appliesTo === file || d.appliesTo === 'both')).toBe(true);
    expect(listed.map(ident)).toEqual(
      getAllDirectives()
        .filter((d) => d.appliesTo === file || d.appliesTo === 'both')
        .map(ident),
    );
  });

  it('includes `disabled`, which applies to both files, in each', () => {
    expect(getDirectivesForFile('props.conf').some((d) => d.key === 'disabled')).toBe(true);
    expect(getDirectivesForFile('transforms.conf').some((d) => d.key === 'disabled')).toBe(true);
  });
});

describe('getDirectivesByCategory', () => {
  it('partitions the file listing by category without losing or reordering an entry', () => {
    const byCategory = getDirectivesByCategory('props.conf');
    for (const [category, entries] of byCategory) {
      expect(entries.every((d) => d.category === category)).toBe(true);
    }
    const regrouped = [...byCategory.values()].flat().map(ident).sort();
    expect(regrouped).toEqual(getDirectivesForFile('props.conf').map(ident).sort());
    expect(byCategory.get('Time Configuration')?.[0]?.key).toBe('TIME_PREFIX');
  });

  it('leaves out entries that belong to the other file', () => {
    const keys = [...getDirectivesByCategory('transforms.conf').values()].flat().map((d) => d.appliesTo);
    expect(keys).not.toContain('props.conf');
  });
});
