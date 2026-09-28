import { describe, it, expect } from 'vitest';
import { CIM_MODELS, CIM_VERSION } from '../cim/cimModelsData';

const byName = (name: string) => CIM_MODELS.find((m) => m.name === name)!;
const allFields = (name: string) => {
  const model = byName(name);
  return [...model.requiredFields, ...model.recommendedFields];
};

// A model's events need ALL of its constraint tags to populate, so a
// missing tag doesn't weaken membership — it breaks it entirely.
describe('CIM constraint tags (#37)', () => {
  it('DLP is constrained by tag=dlp tag=incident', () => {
    expect(byName('DLP').tags).toEqual(expect.arrayContaining(['dlp', 'incident']));
  });

  it('Updates is constrained by tag=update tag=status', () => {
    expect(byName('Updates').tags).toEqual(expect.arrayContaining(['update', 'status']));
  });

  it('every model declares at least one constraint tag', () => {
    for (const model of CIM_MODELS) {
      expect(model.tags.length).toBeGreaterThan(0);
    }
  });

  // Endpoint has no model-wide `tag=endpoint` constraint: each of its five root
  // datasets carries its own tag pair, so each is modelled separately.
  it('each Endpoint dataset carries its own tag pair', () => {
    expect(byName('Endpoint.Ports').tags).toEqual(['listening', 'port']);
    expect(byName('Endpoint.Processes').tags).toEqual(['process', 'report']);
    expect(byName('Endpoint.Services').tags).toEqual(['service', 'report']);
    expect(byName('Endpoint.Filesystem').tags).toEqual(['endpoint', 'filesystem']);
    expect(byName('Endpoint.Registry').tags).toEqual(['endpoint', 'registry']);
  });
});

// Every listed field is one the model defines, so the CIM tab never reports
// non-compliance against fields nobody can populate.
describe('CIM field lists match Splunk_SA_CIM (#37)', () => {
  it('is generated from a pinned CIM release', () => {
    expect(CIM_VERSION).toBe('8.5.0');
  });

  it('does not over-apply vendor_product', () => {
    // Real in Network Traffic, Web, Malware, IDS, Email, Change, Updates…
    for (const name of ['Network_Traffic', 'Web', 'Malware', 'Intrusion_Detection', 'Email', 'Change', 'Updates']) {
      expect(allFields(name)).toContain('vendor_product');
    }
    // …but genuinely absent from these four.
    for (const name of ['Authentication', 'Alerts', 'Certificates', 'Performance']) {
      expect(allFields(name)).not.toContain('vendor_product');
    }
  });

  it('Databases lists the fields the model actually defines', () => {
    const fields = allFields('Databases');
    for (const invalid of ['action', 'app', 'query_type', 'status', 'db_name']) {
      expect(fields).not.toContain(invalid);
    }
    // The database name is `instance_name`, not `db_name`.
    for (const real of ['instance_name', 'query', 'query_id', 'object', 'dest', 'src', 'user', 'duration']) {
      expect(fields).toContain(real);
    }
  });

  it('DLP lists object/dlp_type fields, not the file/url ones', () => {
    const fields = allFields('DLP');
    for (const invalid of ['file_name', 'file_path', 'protocol', 'url']) {
      expect(fields).not.toContain(invalid);
    }
    for (const real of ['object', 'object_path', 'dlp_type', 'signature', 'src_user', 'dvc', 'severity']) {
      expect(fields).toContain(real);
    }
  });

  it('drops fields the models never had', () => {
    expect(allFields('Vulnerabilities')).not.toContain('dest_port');
    expect(allFields('Vulnerabilities')).not.toContain('os');
    // `os` is a tag on the Performance OS dataset, not a field.
    expect(allFields('Performance')).not.toContain('os');
  });

  it('omits asset/identity enrichment fields an add-on must not extract', () => {
    const enrichment = /^(dest|src|dvc|user|src_user)_(bunit|category|priority)$/;
    for (const model of CIM_MODELS) {
      for (const field of [...model.requiredFields, ...model.recommendedFields]) {
        expect(field, `${model.name}.${field}`).not.toMatch(enrichment);
        expect(field, `${model.name}.${field}`).not.toBe('tag');
      }
    }
  });

  it('has unique names and no field listed as both required and recommended', () => {
    const names = CIM_MODELS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);

    for (const model of CIM_MODELS) {
      const required = new Set(model.requiredFields);
      const overlap = model.recommendedFields.filter((f) => required.has(f));
      expect(overlap, `${model.name} duplicates`).toEqual([]);
      expect(model.requiredFields.length + model.recommendedFields.length).toBeGreaterThan(0);
    }
  });
});
