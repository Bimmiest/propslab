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
 *
 * Each response shape, and the serialized event inside simulate's, is checked
 * at compile time against the type the worker builds (`satisfies ShapeOf<…>`):
 * the same keys, none missing and none extra, each schema producing that
 * field's type. A field added to the serializer and not here — which strict
 * validation would then reject on every call — fails the build instead.
 */
import { z } from 'zod';
import type { ExplainResponse, ValidateResponse } from './protocol';
import type { SerializedEvent, SerializedSimulation } from './serialize';

/** A zod shape with exactly `T`'s keys, each producing a value of that field's type. */
type ShapeOf<T> = { [K in keyof T]-?: z.ZodType<T[K]> };

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
  timeSource: z
    .enum([
      'TIME_FORMAT',
      'auto-recognition',
      'previous-event',
      'current-time',
      'datetime-config-current',
      'datetime-config-none',
    ])
    .optional(),
  inputSnapshot: z.string().optional(),
  outputSnapshot: z.string().optional(),
  fieldsAdded: z.array(z.string()).optional(),
  fieldsModified: z.array(z.string()).optional(),
  fieldsRemoved: z.array(z.string()).optional(),
  fieldAliases: z.array(z.object({ target: z.string(), source: z.string() })).optional(),
  evalExpressions: z.record(z.string(), z.string()).optional(),
  metadataChanges: z.array(z.object({ key: metadata.keyof(), from: z.string(), to: z.string() })).optional(),
});

/** Why a directive did nothing, by case (the engine's `NoOpReason`). */
const noOpReason = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('stanza-not-matched'), stanza: z.string(), wonInstead: z.string().optional() }),
  z.looseObject({ kind: z.literal('transforms-stanza-missing'), name: z.string() }),
  z.looseObject({ kind: z.literal('regex-invalid'), error: z.string() }),
  z.looseObject({ kind: z.literal('regex-limit'), error: z.string() }),
  z.looseObject({ kind: z.literal('source-key-empty'), sourceKey: z.string() }),
  z.looseObject({
    kind: z.literal('no-match'),
    partialEnd: z.number().int().optional(),
    partialPattern: z.string().optional(),
  }),
  z.looseObject({ kind: z.literal('fields-already-set'), fields: z.array(z.string()) }),
  z.looseObject({ kind: z.literal('values-empty'), fields: z.array(z.string()) }),
  z.looseObject({ kind: z.literal('eval-null'), expression: z.string() }),
  z.looseObject({ kind: z.literal('not-explained') }),
]);

/** A directive that applied to an event and changed nothing. */
const noOp = z.looseObject({
  directive: z.string(),
  file: confFile,
  line: z.number().int(),
  phase,
  reason: noOpReason,
  description: z.string().describe("The reason in one line, as the app's Pipeline tab shows it."),
});

const serializedEvent = z.object({
  _raw: z.string(),
  _time: z.string().nullable().describe('ISO-8601, or null when no timestamp was assigned.'),
  metadata,
  fields: fieldValues,
  indexedFields: fieldValues,
  lineNumbers: lineRange,
  processingTrace: z.array(traceStep),
  fieldOffsets: z
    .record(z.string(), z.array(z.tuple([z.number().int(), z.number().int()])))
    .optional()
    .describe(
      'With capture_offsets only: [start, end) offsets in _raw of each value a positional ' +
        'EXTRACT captured, per field.',
    ),
  noOps: z.array(noOp).optional().describe('Directives that applied to this event and changed nothing, each with why.'),
  clonedFrom: z
    .string()
    .optional()
    .describe('CLONE_SOURCETYPE copies only: the sourcetype the original event carried.'),
} satisfies ShapeOf<SerializedEvent>);

export const simulateOutputShape = {
  eventCount: z.number().int().describe('Events the run produced, returned or not.'),
  returnedEvents: z.number().int(),
  truncationNote: z
    .string()
    .optional()
    .describe('Present when events or diagnostics were cut by max_events or the size cap.'),
  events: z.array(serializedEvent),
  diagnostics: z.array(diagnostic),
  diagnosticCount: z
    .number()
    .int()
    .optional()
    .describe('Total diagnostics; present only when `diagnostics` was cut to fit.'),
} satisfies ShapeOf<SerializedSimulation>;

const cutCount = (list: string) =>
  z.number().int().optional().describe(`Total ${list}; present only when \`${list}\` was cut to fit the size cap.`);

const capNote = z.string().optional().describe('Present when a list was cut to fit the size cap; says which.');

export const validateOutputShape = {
  diagnostics: z.array(diagnostic),
  diagnosticCount: cutCount('diagnostics'),
  truncationNote: capNote,
} satisfies ShapeOf<ValidateResponse>;

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
  directiveCount: cutCount('directives'),
});

export const explainOutputShape = {
  parseErrors: z.array(diagnostic),
  stanzas: z.array(explainStanza),
  parseErrorCount: cutCount('parseErrors'),
  stanzaCount: cutCount('stanzas'),
  truncationNote: capNote,
  resolution: z
    .object({
      metadata,
      effectiveMetadata: metadata,
      assignedSourcetype: z.string().optional(),
      matchedStanzas: z.array(z.object({ name: z.string(), type: stanzaType, layer: z.string().optional() })),
      effectiveDirectives: z.array(z.object({ ...explainDirectiveShape, stanza: z.string() })),
      matchedStanzaCount: cutCount('matchedStanzas'),
      effectiveDirectiveCount: cutCount('effectiveDirectives'),
    })
    .optional()
    .describe('props.conf with a sourcetype only: matched stanzas and the merged directive set.'),
} satisfies ShapeOf<ExplainResponse>;

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
  'props.conf': z.array(directiveSummary).optional().describe('Listing mode (no key): every props.conf directive.'),
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
