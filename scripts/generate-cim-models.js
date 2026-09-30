#!/usr/bin/env node
// Regenerates src/engine/cim/cimModelsData.ts from Splunk's CIM add-on.
//
// Usage:
//   1. Download "Splunk Common Information Model (CIM)" from Splunkbase
//      (https://splunkbase.splunk.com/app/1621) and extract it:
//        tar xzf splunk-common-information-model-cim_<ver>.tgz -C /tmp
//   2. node scripts/generate-cim-models.js /tmp/Splunk_SA_CIM
//   3. Review the diff, then run `npm test` — the CIM tests assert the
//      generated models, and CIM_VERSION is pinned in the suite.
//
// This is a manual, occasional step (CIM ships roughly annually), not part of
// the build: nothing here runs at build or install time and the add-on is not
// vendored. You are running it against a copy of the add-on you obtained and
// licensed yourself; the output carries identifiers that stay Splunk Inc.'s,
// which the NOTICE file at the repository root spells out. The point is that
// the field lists are transcribed by a script with stated rules rather than by
// hand: a hand-maintained list drifts into claiming fields a model never
// defined.
//
// The derivation rules are documented in the header this script emits.

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src/engine/cim/cimModelsData.ts',
);

// The curated layer: which CIM root datasets the toolkit presents, and how they
// are labelled. Everything else about an entry — fields, split, tags — is read
// out of the add-on. Keys are `<modelName>/<objectName>`; a key that no longer
// resolves is a hard error, so a renamed dataset cannot silently vanish.
//
// Deliberately omitted: Application_State and Change_Analysis (deprecated by
// Splunk), Splunk_Audit (models Splunk's own _audit/_internal logs, not
// anything props.conf extracts), and Splunk_CIM_Validation (a validation
// helper, not a content model).
const INCLUDE = {
  'Alerts/Alerts': {
    name: 'Alerts',
    displayName: 'Alerts',
    description: 'Alert and notification events from monitoring systems',
    tags: ['alert'],
  },
  'Authentication/Authentication': {
    name: 'Authentication',
    displayName: 'Authentication',
    description: 'Login/logout events and user access attempts',
    tags: ['authentication'],
  },
  'Certificates/All_Certificates': {
    name: 'Certificates',
    displayName: 'Certificates',
    description: 'SSL/TLS certificate lifecycle and validation',
    tags: ['certificate'],
    note: 'The ssl_* fields belong to the child SSL dataset (tag=ssl OR tag=tls).',
  },
  'Change/All_Changes': {
    name: 'Change',
    displayName: 'Change',
    description: 'Configuration, account and instance change events',
    tags: ['change'],
  },
  'Compute_Inventory/All_Inventory': {
    name: 'Compute_Inventory',
    displayName: 'Inventory',
    description: 'CPU, memory, storage, network and OS inventory records',
    tags: ['inventory'],
    note: 'Also needs one of tag=cpu / memory / network / storage / (system version) / user / virtual.',
  },
  'DLP/DLP_Incidents': {
    name: 'DLP',
    displayName: 'Data Loss Prevention',
    description: 'Data protection and exfiltration incidents',
    tags: ['dlp', 'incident'],
  },
  'Data_Access/Data_Access': {
    name: 'Data_Access',
    displayName: 'Data Access',
    description: 'Access to files, records and objects in data stores',
    tags: ['data', 'access'],
  },
  'Databases/All_Databases': {
    name: 'Databases',
    displayName: 'Databases',
    description: 'Database instance, session, lock and query activity',
    tags: ['database'],
    note: 'CIM declares no key fields for this model, so nothing is listed as required.',
  },
  'Email/All_Email': {
    name: 'Email',
    displayName: 'Email',
    description: 'Email client, gateway and filtering events',
    tags: ['email'],
  },
  'Endpoint/Filesystem': {
    name: 'Endpoint.Filesystem',
    displayName: 'Endpoint: Filesystem',
    description: 'File create/read/write/delete activity on a host',
    tags: ['endpoint', 'filesystem'],
  },
  'Endpoint/Ports': {
    name: 'Endpoint.Ports',
    displayName: 'Endpoint: Ports',
    description: 'Listening network ports on a host',
    tags: ['listening', 'port'],
  },
  'Endpoint/Processes': {
    name: 'Endpoint.Processes',
    displayName: 'Endpoint: Processes',
    description: 'Process execution and parent/child process activity',
    tags: ['process', 'report'],
  },
  'Endpoint/Registry': {
    name: 'Endpoint.Registry',
    displayName: 'Endpoint: Registry',
    description: 'Windows registry key and value activity',
    tags: ['endpoint', 'registry'],
  },
  'Endpoint/Services': {
    name: 'Endpoint.Services',
    displayName: 'Endpoint: Services',
    description: 'Service inventory and start/stop state on a host',
    tags: ['service', 'report'],
  },
  'Event_Signatures/Signatures': {
    name: 'Event_Signatures',
    displayName: 'Event Signatures',
    description: 'Vendor event codes tracked for signature reporting',
    tags: ['track_event_signatures'],
    note: 'Also requires signature or signature_id to be present.',
  },
  'Interprocess_Messaging/All_Messaging': {
    name: 'Interprocess_Messaging',
    displayName: 'Interprocess Messaging',
    description: 'Message queue and RPC request/response events',
    tags: ['messaging'],
    note: 'CIM declares no key fields for this model, so nothing is listed as required.',
  },
  'Intrusion_Detection/IDS_Attacks': {
    name: 'Intrusion_Detection',
    displayName: 'Intrusion Detection',
    description: 'IDS/IPS security alerts',
    tags: ['ids', 'attack'],
  },
  'JVM/JVM': {
    name: 'JVM',
    displayName: 'JVM',
    description: 'Java Virtual Machine runtime, memory and threading metrics',
    tags: ['jvm'],
    note: 'CIM declares no key fields for this model, so nothing is listed as required.',
  },
  'Malware/Malware_Attacks': {
    name: 'Malware',
    displayName: 'Malware',
    description: 'Anti-malware and malicious file detections',
    tags: ['malware', 'attack'],
    note: 'The Malware_Operations dataset (`tag=malware tag=operations`) is not modelled here.',
  },
  'Network_Resolution/DNS': {
    name: 'Network_Resolution',
    displayName: 'Network Resolution (DNS)',
    description: 'DNS query and resolution events',
    tags: ['network', 'resolution', 'dns'],
  },
  'Network_Sessions/All_Sessions': {
    name: 'Network_Sessions',
    displayName: 'Network Sessions',
    description: 'DHCP/VPN session start and end events',
    tags: ['network', 'session'],
  },
  'Network_Traffic/All_Traffic': {
    name: 'Network_Traffic',
    displayName: 'Network Traffic',
    description: 'Firewall, proxy, and network flow data',
    tags: ['network', 'communicate'],
  },
  'Performance/All_Performance': {
    name: 'Performance',
    displayName: 'Performance',
    description: 'System performance metrics (CPU, memory, storage, network, facilities)',
    tags: ['performance'],
    note: 'Also needs one of tag=cpu / facilities / memory / storage / network / (os with time+synchronize or uptime).',
  },
  'Ticket_Management/All_Ticket_Management': {
    name: 'Ticket_Management',
    displayName: 'Ticket Management',
    description: 'Incident, problem and change tickets',
    tags: ['ticketing'],
  },
  'Updates/Updates': {
    name: 'Updates',
    displayName: 'Updates',
    description: 'Software patches and update installations',
    tags: ['update', 'status'],
    note: 'The Update_Errors dataset (`tag=update tag=error`) is not modelled here.',
  },
  'Vulnerabilities/Vulnerabilities': {
    name: 'Vulnerabilities',
    displayName: 'Vulnerabilities',
    description: 'Vulnerability scan results and assessments',
    tags: ['vulnerability', 'report'],
  },
  'Web/Web': {
    name: 'Web',
    displayName: 'Web',
    description: 'HTTP/HTTPS requests and responses',
    tags: ['web'],
  },
};

// Splunk_CIM_Validation checks Ticket_Management at three levels; only
// Missing_Extractions_All_Ticket_Managment (sic) belongs to the root dataset —
// change/incident/problem are checks on the child datasets.
const VALIDATION_OVERRIDE = {
  Ticket_Management: ['dest', 'ticket_id'],
};

// Throws rather than exiting so the transformation can be driven from a test
// (src/__tests__/generateCimModels.test.ts); the command line below turns it
// into a message and a non-zero exit.
function die(message) {
  throw new Error(message);
}

function locate(input) {
  const candidates = [
    join(input, 'default', 'data', 'models'),
    join(input, 'data', 'models'),
    input,
  ];
  const models = candidates.find(
    (dir) => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json')),
  );
  if (!models) die(`no CIM model JSON found under ${input}`);

  // Provenance: take the version from the add-on rather than trusting the
  // filename or the operator's memory.
  const appConf = [
    join(input, 'default', 'app.conf'),
    join(models, '..', '..', 'app.conf'),
  ].find(existsSync);
  if (!appConf) die(`found models at ${models} but no default/app.conf to read the CIM version from`);

  const version = /^\s*version\s*=\s*(\S+)\s*$/m.exec(readFileSync(appConf, 'utf8'))?.[1];
  if (!version) die(`no "version =" in ${appConf}`);

  return { models, version };
}

// A dataset's fields are its own `fields` plus every calculation output field —
// the CIM defines action/src/dest/user and friends as eval calculations, so
// reading `fields` alone misses most of the fields that matter.
function datasetFields(object) {
  return [
    ...(object.fields ?? []),
    ...(object.calculations ?? []).flatMap((calc) => calc.outputFields ?? []),
  ];
}

// Skip hidden fields and asset/identity enrichment (`ta_relevant: false`):
// Splunk populates those downstream from its own lookups, so reporting them as
// extraction gaps tells an add-on author to do something they must not do.
function usable(field) {
  return !field.hidden && field.comment?.ta_relevant !== false;
}

function descendants(model, rootName) {
  const out = [];
  const stack = [rootName];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const object of model.objects) {
      if (object.parentName === current) {
        out.push(object);
        stack.push(object.objectName);
      }
    }
  }
  return out;
}

// Splunk_CIM_Validation's `Missing_Extractions_*` datasets are Splunk's own
// "key fields are missing" checks, keyed by the model they check.
function validationKeys(modelsDir) {
  const doc = JSON.parse(readFileSync(join(modelsDir, 'Splunk_CIM_Validation.json'), 'utf8'));
  const keys = {};
  for (const object of doc.objects) {
    if (!object.objectName.startsWith('Missing_Extractions')) continue;
    const model = object.parentName;
    keys[model] ??= new Set();
    for (const field of object.fields ?? []) keys[model].add(field.fieldName);
  }
  return keys;
}

// `include` is a parameter so the test can run the real transformation over a
// small fixture with its own table instead of the 29 real datasets.
function build(modelsDir, include = INCLUDE) {
  const keys = validationKeys(modelsDir);
  const entries = [];
  const seen = new Set();

  for (const file of readdirSync(modelsDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const doc = JSON.parse(readFileSync(join(modelsDir, file), 'utf8'));

    for (const object of doc.objects) {
      const key = `${doc.modelName}/${object.objectName}`;
      const spec = include[key];
      if (!spec) continue;
      seen.add(key);

      const rootFields = datasetFields(object);
      let requiredFields = [
        ...new Set(
          rootFields.filter((f) => f.comment?.recommended && usable(f)).map((f) => f.fieldName),
        ),
      ].sort();

      // Fallback for the roots that flag nothing: Splunk's own key-field checks.
      if (requiredFields.length === 0) {
        const fallback = VALIDATION_OVERRIDE[doc.modelName] ?? [...(keys[doc.modelName] ?? [])];
        requiredFields = [...fallback].sort();
      }

      const pool = new Set();
      for (const dataset of [object, ...descendants(doc, object.objectName)]) {
        for (const field of datasetFields(dataset)) {
          if (usable(field)) pool.add(field.fieldName);
        }
      }
      // A fallback required field can live on a child dataset (the Certificates
      // ssl_* fields do); it stays required rather than being listed twice.
      const recommendedFields = [...pool].filter((f) => !requiredFields.includes(f)).sort();

      entries.push({ ...spec, requiredFields, recommendedFields });
    }
  }

  const missing = Object.keys(include).filter((key) => !seen.has(key));
  if (missing.length > 0) {
    die(
      `these datasets are no longer in the add-on: ${missing.join(', ')}\n` +
        'Splunk renamed or removed them — update INCLUDE in this script rather than ignoring it.',
    );
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

function render(entries, version) {
  const list = (values) => `[${values.map((v) => `'${v}'`).join(', ')}]`;
  const out = [];

  out.push('// CIM data model definitions, derived from the Splunk Common Information Model');
  out.push(`// add-on (Splunk_SA_CIM) v${version} as shipped on Splunkbase — specifically`);
  out.push('// `default/data/models/*.json`, which is what Splunk itself runs.');
  out.push('//');
  out.push("// LICENCE: the add-on is Splunk Inc.'s and is distributed under Splunk's terms,");
  out.push('// not an open-source licence. The dataset, field, and tag identifiers below are');
  out.push("// derived from it for interoperability and are NOT covered by this project's");
  out.push('// MIT licence — see the NOTICE file at the repository root. The add-on itself');
  out.push('// is not vendored here and is not needed to build, test, or run the app.');
  out.push('//');
  out.push('// Regenerate with `node scripts/generate-cim-models.js <path-to-Splunk_SA_CIM>`');
  out.push('// rather than editing by hand. How each entry is derived (see #37 — hand-written');
  out.push("// lists had drifted and listed fields several models don't define):");
  out.push('//');
  out.push('//   * One entry per CIM *root dataset* (a dataset whose parent is BaseEvent or');
  out.push('//     BaseSearch), because a root dataset + its tags is what an event actually');
  out.push('//     maps onto. Endpoint has five independent root datasets and no model-wide');
  out.push('//     `tag=endpoint` constraint, so it is five entries.');
  out.push("//   * Field pool = the dataset's own fields plus every calculation output field,");
  out.push('//     and the same for all of its descendant datasets. Hidden fields and fields');
  out.push('//     marked `ta_relevant: false` are dropped: the latter are asset/identity');
  out.push('//     enrichment (`*_bunit`, `*_category`, `*_priority`, `tag`, …) that Splunk');
  out.push('//     adds downstream and that an add-on must NOT extract.');
  out.push('//   * requiredFields = the fields the root dataset flags `comment.recommended:');
  out.push("//     true`. Where a root flags none, the fallback is the key fields Splunk's own");
  out.push('//     Splunk_CIM_Validation model checks for that model (its `Missing_Extractions_*`');
  out.push('//     datasets). Three models declare neither and so require nothing.');
  out.push('//   * recommendedFields = the rest of the pool.');
  out.push('//   * tags = the tags the root constraint requires conjunctively. An event needs');
  out.push('//     ALL of them, so a missing tag breaks dataset membership outright.');
  out.push('');
  out.push('export interface CimModel {');
  out.push('  /** CIM dataset identifier: model name, or `Model.Dataset` where a model has several root datasets. */');
  out.push('  name: string;');
  out.push('  displayName: string;');
  out.push('  description: string;');
  out.push('  requiredFields: string[];');
  out.push('  recommendedFields: string[];');
  out.push('  /** Tags the dataset constraint requires — an event needs ALL of them to populate the dataset. */');
  out.push('  tags: string[];');
  out.push('}');
  out.push('');
  out.push('/** Version of the Splunk_SA_CIM add-on these definitions were generated from. */');
  out.push(`export const CIM_VERSION = '${version}';`);
  out.push('');
  out.push('export const CIM_MODELS: CimModel[] = [');
  for (const entry of entries) {
    out.push('  {');
    if (entry.note) out.push(`    // ${entry.note}`);
    out.push(`    name: '${entry.name}',`);
    out.push(`    displayName: '${entry.displayName}',`);
    out.push(`    description: '${entry.description}',`);
    out.push(`    requiredFields: ${list(entry.requiredFields)},`);
    out.push(`    recommendedFields: ${list(entry.recommendedFields)},`);
    out.push(`    tags: ${list(entry.tags)},`);
    out.push('  },');
  }
  out.push('];');
  out.push('');

  return out.join('\n');
}

export { INCLUDE, locate, build, render };

function main() {
  const input = process.argv[2];
  if (!input) die('usage: node scripts/generate-cim-models.js <path-to-extracted-Splunk_SA_CIM>');

  const { models, version } = locate(resolve(input));
  const entries = build(models);
  writeFileSync(OUTPUT, render(entries, version));
  console.log(`CIM ${version}: wrote ${entries.length} datasets to ${OUTPUT}`);
}

// Importing this file (the unit test does) must not write anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
