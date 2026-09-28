/**
 * Output schemas for the four tools: what each success result carries as
 * `structuredContent`, advertised in `tools/list` as `outputSchema`.
 *
 * The SDK publishes a zod object as JSON Schema with
 * `additionalProperties: false`, and clients validate `structuredContent`
 * against it. Objects this package builds (the response envelopes, a
 * serialized event) are therefore `z.object`, exact; objects the engine or
 * registry defines (diagnostics, trace steps, directive entries) are
 * `z.looseObject`, so a new optional engine field is not an output-validation
 * failure on every call.
 */
import { z } from 'zod';

const lineRange = z.object({ start: z.number().int(), end: z.number().int() });
const phase = z.enum(['index-time', 'search-time']);
const confFile = z.enum(['props.conf', 'transforms.conf']);
const stanzaType = z.enum(['sourcetype', 'source', 'host', 'default']);

const metadata = z.object({
  index: z.string(),
  host: z.string(),
  source: z.string(),
  sourcetype: z.string(),
});

const diagnostic = z.looseObject({
  level: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  file: z.enum(['props.conf', 'transforms.conf', 'raw']),
  layer: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  directiveKey: z.string().optional(),
  suggestion: z.string().optional(),
});

const fieldValues = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

const traceStep = z.looseObject({
  processor: z.string(),
  phase,
  description: z.string(),
  timeSource: z.string().optional(),
  inputSnapshot: z.string().optional(),
  outputSnapshot: z.string().optional(),
  fieldsAdded: z.array(z.string()).optional(),
  fieldsModified: z.array(z.string()).optional(),
  fieldsRemoved: z.array(z.string()).optional(),
  fieldAliases: z.array(z.object({ target: z.string(), source: z.string() })).optional(),
  evalExpressions: z.record(z.string(), z.string()).optional(),
  metadataChanges: z
    .array(z.object({ key: metadata.keyof(), from: z.string(), to: z.string() }))
    .optional(),
});

const serializedEvent = z.object({
  _raw: z.string(),
  _time: z.string().nullable().describe('ISO-8601, or null when no timestamp was assigned.'),
  metadata,
  fields: fieldValues,
  indexedFields: fieldValues,
  lineNumbers: lineRange,
  processingTrace: z.array(traceStep),
});

export const simulateOutputShape = {
  eventCount: z.number().int().describe('Events the run produced, returned or not.'),
  returnedEvents: z.number().int(),
  truncationNote: z
    .string()
    .optional()
    .describe('Present when events or diagnostics were cut by max_events or the size cap.'),
  events: z.array(serializedEvent),
  processingSteps: z
    .array(traceStep)
    .describe("The returned events' trace steps, in order."),
  diagnostics: z.array(diagnostic),
  diagnosticCount: z
    .number()
    .int()
    .optional()
    .describe('Total diagnostics; present only when `diagnostics` was cut to fit.'),
};

export const validateOutputShape = {
  diagnostics: z.array(diagnostic),
};

const overridden = z.object({ layer: z.string(), line: z.number().int(), value: z.string() });

const explainDirectiveShape = {
  key: z.string(),
  value: z.string(),
  line: z.number().int(),
  layer: z.string().optional(),
  overrides: z.array(overridden).optional(),
  overriddenBy: overridden.optional(),
};

const explainStanza = z.object({
  name: z.string(),
  type: stanzaType,
  lineRange,
  layer: z.string().optional(),
  layers: z.array(z.object({ layer: z.string(), lineRange })).optional(),
  directives: z.array(z.object(explainDirectiveShape)),
});

export const explainOutputShape = {
  parseErrors: z.array(diagnostic),
  stanzas: z.array(explainStanza),
  resolution: z
    .object({
      metadata,
      effectiveMetadata: metadata,
      assignedSourcetype: z.string().optional(),
      matchedStanzas: z.array(
        z.object({ name: z.string(), type: stanzaType, layer: z.string().optional() }),
      ),
      effectiveDirectives: z.array(z.object({ ...explainDirectiveShape, stanza: z.string() })),
    })
    .optional()
    .describe('props.conf with a sourcetype only: matched stanzas and the merged directive set.'),
};

const directiveSummary = z.looseObject({
  key: z.string(),
  category: z.string(),
  phase: z.enum(['index-time', 'search-time', 'both']),
  valueType: z.string(),
  support: z.enum(['simulated', 'documented', 'ignored']),
});

const directiveEntry = z.looseObject({
  file: confFile,
  key: z.string(),
  description: z.string(),
  example: z.string(),
  defaultValue: z.string(),
  category: z.string(),
  appliesTo: z.enum(['props.conf', 'transforms.conf', 'both']),
  valueType: z.string(),
  enumValues: z.array(z.string()).optional(),
  isClassBased: z.boolean(),
  phase: z.enum(['index-time', 'search-time', 'both']),
  deprecated: z.boolean().optional(),
  support: z.enum(['simulated', 'documented', 'ignored']),
  supportNote: z.string().optional(),
  supportIssue: z.number().int().optional(),
});

/** One shape for both modes: a listing (no `key`) or the matches for a key. */
export const lookupOutputShape = {
  'props.conf': z
    .array(directiveSummary)
    .optional()
    .describe('Listing mode (no key): every props.conf directive.'),
  'transforms.conf': z
    .array(directiveSummary)
    .optional()
    .describe('Listing mode (no key): every transforms.conf directive.'),
  matches: z
    .array(directiveEntry)
    .optional()
    .describe('Lookup mode: the registry entry for the key, per file it applies to.'),
  classBased: z
    .object({ base: z.string(), className: z.string() })
    .optional()
    .describe('Lookup mode, class-based keys (e.g. EXTRACT-foo) only.'),
};
