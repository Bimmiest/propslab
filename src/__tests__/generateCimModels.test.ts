import { describe, it, expect } from 'vitest';
import { CIM_MODELS, CIM_VERSION } from '../engine/cim/cimModelsData';

/**
 * The CIM generator (#518).
 *
 * `scripts/generate-cim-models.js` needs the Splunk CIM add-on, which is a
 * Splunkbase download behind a login and under Splunk's licence, so CI cannot
 * run it against the real thing and nothing checks that `cimModelsData.ts` is
 * what it would write. This tests what can be tested without the add-on:
 *
 *  - the transformation, on a small synthetic add-on in `fixtures/cim` (invented
 *    models, so no Splunk content is committed), against the derivation rules
 *    the generator states in the header it emits;
 *  - the output format, by feeding the COMMITTED table back through `render` and
 *    requiring the committed file, byte for byte. That is the part of
 *    reproducibility that does not depend on the add-on: a template change, or a
 *    hand edit to the generated file, fails here.
 *
 * What stays manual: that the field lists still match the add-on's current
 * version. See CONTRIBUTING.md, "Add or update a CIM model".
 *
 * The script and the committed file are read through import.meta.glob, as
 * docs.test.ts reads the markdown: the app's tsconfig has no Node types, and the
 * script is plain JS outside every tsconfig.
 */

interface Spec {
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  note?: string;
}
interface Entry extends Spec {
  requiredFields: string[];
  recommendedFields: string[];
}
interface Generator {
  INCLUDE: Record<string, Spec>;
  locate: (input: string) => { models: string; version: string };
  build: (modelsDir: string, include?: Record<string, Spec>) => Entry[];
  render: (entries: Entry[], version: string) => string;
}

const scripts = import.meta.glob<Generator>('/scripts/generate-cim-models.js', { eager: true });
const { INCLUDE, locate, build, render } = scripts['/scripts/generate-cim-models.js']!;
const committedFiles = import.meta.glob<string>('/src/engine/cim/cimModelsData.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const committed = committedFiles['/src/engine/cim/cimModelsData.ts']!;

/** A directory beside this file, as the path the script's fs calls want. */
const fixture = (name: string): string => {
  const path = decodeURIComponent(new URL(`./fixtures/${name}`, import.meta.url).pathname);
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
};
const FIXTURE = fixture('cim');

const FIXTURE_INCLUDE: Record<string, Spec> = {
  'Widgets/All_Widgets': {
    name: 'Widgets', displayName: 'Widgets', description: 'Invented widgets', tags: ['widget'],
    note: 'A note becomes a comment above the entry.',
  },
  'Gadgets/All_Gadgets': { name: 'Gadgets', displayName: 'Gadgets', description: 'Invented gadgets', tags: ['gadget', 'device'] },
  'Ticket_Management/All_Ticket_Management': {
    name: 'Ticket_Management', displayName: 'Tickets', description: 'Invented tickets', tags: ['ticketing'],
  },
};

const entry = (entries: Entry[], name: string): Entry => {
  const found = entries.find((e) => e.name === name);
  if (!found) throw new Error(`no entry ${name}`);
  return found;
};

describe('generate-cim-models: locate', () => {
  it('finds the models and takes the version from app.conf, not the directory name', () => {
    const found = locate(FIXTURE);
    expect(found.version).toBe('1.2.3');
    expect(found.models.replaceAll('\\', '/')).toBe(`${FIXTURE}/default/data/models`);
  });

  it('refuses a directory with no model JSON', () => {
    expect(() => locate(fixture('.'))).toThrow(/no CIM model JSON/);
  });

  it('refuses an add-on it cannot read a version from, rather than guessing one', () => {
    expect(() => locate(fixture('cim-noconf'))).toThrow(/no default\/app\.conf/);
    expect(() => locate(fixture('cim-noversion'))).toThrow(/no "version ="/);
  });
});

describe('generate-cim-models: build', () => {
  const entries = build(locate(FIXTURE).models, FIXTURE_INCLUDE);

  it('emits one entry per listed root dataset, sorted by name, and none for unlisted ones', () => {
    expect(entries.map((e) => e.name)).toEqual(['Gadgets', 'Ticket_Management', 'Widgets']);
  });

  // Rule (the header the generator emits): required = the root's fields flagged
  // `comment.recommended`, calculation output fields included; hidden fields and
  // `ta_relevant: false` enrichment are dropped; the rest of the pool, taken
  // over the root and all descendants, is recommended.
  it('reads required fields from the recommended flag, including calculation outputs', () => {
    expect(entry(entries, 'Widgets').requiredFields).toEqual(['action', 'id']);
  });

  it('pools descendants into recommended, without repeating required fields or dropped ones', () => {
    const { recommendedFields } = entry(entries, 'Widgets');
    expect(recommendedFields).toEqual(['colour', 'length_mm', 'weight_kg']);
    expect(recommendedFields).not.toContain('internal_flag');
    expect(recommendedFields).not.toContain('widget_priority');
    expect(recommendedFields).not.toContain('never_emitted');
  });

  // Rule: where a root flags nothing, the fallback is the key fields of the
  // model's Missing_Extractions_* checks in Splunk_CIM_Validation. Those fields
  // live on a child dataset here, and stay required rather than also being
  // listed as recommended.
  it('falls back to the validation model when the root flags nothing', () => {
    const gadgets = entry(entries, 'Gadgets');
    expect(gadgets.requiredFields).toEqual(['owner', 'serial']);
    expect(gadgets.recommendedFields).toEqual(['model']);
  });

  // Rule (the script's VALIDATION_OVERRIDE): Ticket_Management's checks cover
  // three levels and only two fields belong to the root.
  it('applies the Ticket_Management override instead of the validation checks', () => {
    expect(entry(entries, 'Ticket_Management').requiredFields).toEqual(['dest', 'ticket_id']);
  });

  it('carries the curated layer through untouched', () => {
    expect(entry(entries, 'Gadgets').tags).toEqual(['gadget', 'device']);
    expect(entry(entries, 'Widgets').note).toBe('A note becomes a comment above the entry.');
  });

  it('fails, naming the dataset, when one in the table is gone from the add-on', () => {
    const include = { ...FIXTURE_INCLUDE, 'Widgets/Renamed_Widgets': FIXTURE_INCLUDE['Widgets/All_Widgets']! };
    expect(() => build(locate(FIXTURE).models, include)).toThrow(/no longer in the add-on: Widgets\/Renamed_Widgets/);
  });
});

describe('generate-cim-models: render', () => {
  const out = render(build(locate(FIXTURE).models, FIXTURE_INCLUDE), '9.9.9');

  it('stamps the add-on version into the header and the exported constant', () => {
    expect(out).toContain('add-on (Splunk_SA_CIM) v9.9.9 as shipped on Splunkbase');
    expect(out).toContain("export const CIM_VERSION = '9.9.9';");
  });

  it('writes field lists as single-line arrays and notes as comments', () => {
    expect(out).toContain("    requiredFields: ['action', 'id'],");
    expect(out).toContain("    // A note becomes a comment above the entry.\n    name: 'Widgets',");
  });

  it('keeps the licence notice, which the committed file carries', () => {
    expect(out).toMatch(/\/\/ LICENCE: the add-on is Splunk Inc\.'s/);
  });
});

describe('generate-cim-models: the committed cimModelsData.ts', () => {
  // The curated table and the data are separate inputs to the generator, so a
  // dataset is looked up by its display name to recover its note.
  const notes = new Map(Object.values(INCLUDE).map((spec) => [spec.name, spec.note]));

  it('is what render() writes for its own contents', () => {
    const entries = CIM_MODELS.map((model) => {
      const note = notes.get(model.name);
      return { ...model, ...(note === undefined ? {} : { note }) };
    });
    expect(render(entries, CIM_VERSION)).toBe(committed);
  });

  it('lists exactly the datasets the generator would include', () => {
    expect(CIM_MODELS.map((m) => m.name).sort()).toEqual(Object.values(INCLUDE).map((s) => s.name).sort());
  });
});
