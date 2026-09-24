export interface EventMetadata {
  index: string;
  host: string;
  source: string;
  sourcetype: string;
}

/**
 * Which rule in the timestamp fallback chain produced an event's `_time` (#85).
 * Splunk tries these in order, and *which one fired* is the single most-debugged
 * ingest behaviour — a `_time` that came from the previous event or from the
 * clock looks identical in the output to one that was parsed from the text.
 */
export type TimeSource =
  | 'TIME_FORMAT'
  | 'auto-recognition'
  | 'previous-event'
  | 'current-time'
  | 'datetime-config-current'
  | 'datetime-config-none';

/** `_time` sources that were not read out of the event's own text. */
export const FALLBACK_TIME_SOURCES: readonly TimeSource[] = [
  'previous-event',
  'current-time',
  'datetime-config-current',
  'datetime-config-none',
];

export interface ProcessingStep {
  processor: string;
  phase: 'index-time' | 'search-time';
  description: string;
  /**
   * Set by `timestampExtractor` on the step that resolved `_time`. Structured
   * rather than parsed back out of `description`, for the reason spelled out on
   * `fieldAliases` below.
   */
  timeSource?: TimeSource;
  inputSnapshot?: string;
  outputSnapshot?: string;
  fieldsAdded?: string[];
  /**
   * Fields that still extract after this step but whose value changed — the
   * signature of a mask rule eating a value that an extraction does find.
   * Populated for steps that rewrite `_raw` (SEDCMD, DEST_KEY = _raw) by
   * `attributeRawMutations`, which runs after search-time extraction.
   */
  fieldsModified?: string[];
  /**
   * Fields that extracted from the pre-step `_raw` and no longer extract at all
   * — the step deleted the text the extraction anchors on. Distinct from
   * `fieldsModified`: the remedy differs (the extraction is broken, not just
   * devalued), so the two are never merged.
   */
  fieldsRemoved?: string[];
  /**
   * FIELDALIAS steps only: the alias pairs this step created.
   *
   * `description` also names them, but as prose for a human to read. The Fields
   * tab used to recover the mapping by running a regex over that sentence,
   * which made a reworded description silently empty its Aliases column. The
   * structured form is what consumers should read; `description` is for display.
   */
  fieldAliases?: { target: string; source: string }[];
  /**
   * EVAL steps only: the expression each computed field was produced by, keyed
   * by field name.
   *
   * Carried here because it is the only place the association is both correct
   * and already resolved — these are the directives that survived stanza
   * matching for THIS event. Re-reading props.conf in the UI to recover it (as
   * the Extractions tab did) reintroduces every question the parser has already
   * answered: case sensitivity, line continuations, and which stanza applies.
   */
  evalExpressions?: Record<string, string>;
}

/**
 * A single in-place rewrite of `_raw`, recorded at index time so the fields it
 * affected can be attributed after search-time extraction has run.
 *
 * SEDCMD and DEST_KEY = _raw are text substitutions: they have no field
 * parameter and cannot name what they changed. The association only exists by
 * comparison, and the extraction rules needed to compute it do not run until
 * later in the pipeline — hence this transient record rather than an
 * attribution made at the point of the edit.
 */
export interface RawMutation {
  /** Index into the event's `processingTrace` of the step to backfill. */
  traceIndex: number;
  rawBefore: string;
  rawAfter: string;
}

export interface SplunkEvent {
  _raw: string;
  _time: Date | null;
  _meta: Record<string, string>;
  fields: Record<string, string | string[]>;
  /**
   * Maps stripped field name → original raw key when underscore-stripping occurred
   * during INDEXED_EXTRACTIONS. Used by the highlighter to locate the value in _raw
   * using the un-stripped key for context-aware matching.
   * e.g. { 'GID': '_GID', 'AUDIT_SESSION': '_AUDIT_SESSION' }
   */
  fieldSourceKeys?: Record<string, string>;
  /**
   * Authoritative start/end offsets in `_raw` for fields extracted by position.
   * Populated by EXTRACT-* against `_raw`. When present, the highlighter uses
   * these offsets directly instead of searching `_raw` with context patterns,
   * preventing double-highlight / wrong-occurrence bugs for positional captures
   * against unstructured text (e.g. access logs).
   */
  fieldOffsets?: Record<string, Array<[number, number]>>;
  metadata: EventMetadata;
  lineNumbers: { start: number; end: number };
  processingTrace: ProcessingStep[];
  /**
   * Directives that applied to this event and changed nothing, each with the
   * reason (#84).
   *
   * Deliberately NOT part of `processingTrace`: that array is "what happened",
   * every consumer of it treats a step as work done, and the Pipeline tab counts
   * its length. A no-op is the absence of work, so it is recorded beside the
   * trace rather than inside it.
   */
  noOps?: DirectiveNoOp[];
  /**
   * Set on an event produced by `CLONE_SOURCETYPE` (#87): the sourcetype the
   * original carried when the clone was taken. The clone re-enters the pipeline
   * under its NEW sourcetype, so without this there is nothing linking the pair
   * and a duplicated event looks like a line-breaking bug.
   */
  clonedFrom?: string;
  /**
   * Transient: every index-time rewrite of `_raw`, consumed and stripped by
   * `attributeRawMutations` at the end of the pipeline. Never present on the
   * events a caller receives.
   */
  rawMutations?: RawMutation[];
}

/** One directive that did nothing to one event, and why (#84). */
export interface DirectiveNoOp {
  /** As written, e.g. `EXTRACT-user`. */
  directive: string;
  file: 'props.conf' | 'transforms.conf';
  line: number;
  /** Which pipeline stage it belonged to, for grouping in the UI. */
  phase: 'index-time' | 'search-time';
  reason: import('./noOpExplainer').NoOpReason;
}

export interface ProcessingResult {
  events: SplunkEvent[];
  originalRaw: string;
  eventCount: number;
  processingSteps: ProcessingStep[];
  /**
   * The metadata the run was given, before any input-time assignment or
   * index-time rewrite. Carried on the result so a view can say which events
   * a run changed without reading the metadata fields as they are now, which
   * may have been edited since (#316).
   */
  inputMetadata: EventMetadata;
}

export type DiagnosticLevel = 'error' | 'warning' | 'info';

/**
 * Which panel a diagnostic belongs to. `props.conf`/`transforms.conf` are config
 * problems shown under their editors; `raw` is a data-quality problem (e.g. an
 * event that isn't valid JSON) shown under the Raw Log panel, with `line` pointing
 * at the offending input line rather than a config line.
 */
export type DiagnosticTarget = 'props.conf' | 'transforms.conf' | 'raw';

export interface ValidationDiagnostic {
  level: DiagnosticLevel;
  message: string;
  file: DiagnosticTarget;
  /**
   * Which conf layer `line` refers to (see `ConfLayer`). Only present when the
   * config was parsed from layers — with a single flat file `file` + `line`
   * already identifies the position uniquely.
   */
  layer?: string;
  line?: number;
  column?: number;
  directiveKey?: string;
  suggestion?: string;
}

/**
 * One file in a layered read of a conf, e.g. `$APP/default/props.conf` and
 * `$APP/local/props.conf`.
 *
 * `layer` is a free-form label — the engine only carries it through as
 * provenance and never interprets it, so a caller reading a real Splunk install
 * can use whatever identifies the file it came from (`default`, `local`,
 * `myapp/local`, `system/local`, …). Precedence comes from the ORDER of the
 * list handed to `parseConf`, lowest precedence first, because only the caller
 * knows how its layers rank.
 */
export interface ConfLayer {
  layer: string;
  text: string;
}

/**
 * What `parseConf` (and therefore `runPipeline`) accepts for a conf file: either
 * a single flat file's text, or an ordered list of layers, lowest precedence
 * first. A single string parses exactly as it always has, with no provenance
 * fields on the result.
 */
export type ConfInput = string | ConfLayer[];

/**
 * A pointer to a directive that is shadowed by, or shadows, another definition
 * of the same key in the same stanza. Only produced for layered input, where
 * the layer name is always known.
 */
export interface OverriddenDirective {
  layer: string;
  line: number;
  value: string;
}

/** Where a stanza is defined within one layer. */
export interface StanzaLayerOrigin {
  layer: string;
  lineRange: { start: number; end: number };
}

export interface ConfDirective {
  key: string;
  value: string;
  line: number;
  directiveType: string;
  className?: string;
  /**
   * The layer this directive was read from. Absent when the conf was parsed
   * from a single flat string, which has no layer to name.
   */
  layer?: string;
  /**
   * Definitions of the same key, in the same stanza, that this one wins over —
   * nearest first, so `overrides[0]` is the value that would apply if this
   * directive were deleted. Covers both a lower layer (`default` beaten by
   * `local`) and a repeat earlier in the same file, since Splunk resolves both
   * by the same last-definition-wins rule.
   *
   * This is within-stanza only. Which *stanza* won for a given event is a
   * separate axis, resolved later by `matchStanzas`/`mergeDirectives`.
   */
  overrides?: OverriddenDirective[];
  /** Set on a directive that lost to a later definition of the same key. */
  overriddenBy?: OverriddenDirective;
}

export interface ConfStanza {
  name: string;
  type: 'sourcetype' | 'source' | 'host' | 'default';
  sourcePattern?: string;
  hostPattern?: string;
  directives: ConfDirective[];
  /**
   * Line range of the stanza header and body. For layered input this is the
   * range in the HIGHEST-precedence layer that defines the stanza (named by
   * `layer`) — the file an engineer would edit; `layers` has the rest.
   */
  lineRange: { start: number; end: number };
  /** Highest-precedence layer defining this stanza. Absent for flat input. */
  layer?: string;
  /**
   * Every layer that defines this stanza, lowest precedence first. Absent for
   * flat input.
   */
  layers?: StanzaLayerOrigin[];
}

export interface ParsedConf {
  stanzas: ConfStanza[];
  errors: ValidationDiagnostic[];
}

export interface PipelineOptions {
  perEventPipeline: boolean;
  /**
   * Record capture offsets for positional EXTRACTs, populating `fieldOffsets`.
   * Defaults to `true`. Set `false` in a consumer that renders no highlights —
   * it drops the `'d'` flag, which is what makes an EXTRACT eligible for V8's
   * linear-time regex fallback. See `extractFields` for the limits of that.
   */
  captureOffsets?: boolean;
  /**
   * The current time, in epoch milliseconds. Defaults to `Date.now()`.
   *
   * Everything in the simulation that Splunk measures against the clock reads
   * this instead: the MAX_DAYS_AGO / MAX_DAYS_HENCE timestamp bounds, the year
   * a yearless TIME_FORMAT is given, the index-time `_time` an event falls back
   * to, and eval's `now()` / `time()`. A caller replaying recorded data — a test
   * fixture, a saved sample — passes the moment it was recorded, so the verdict
   * does not change as the real clock moves on (#293).
   */
  now?: number;
}

export type OutputTabId = 'preview' | 'cim' | 'fields' | 'transforms' | 'effective' | 'architecture';

export type PreviewSubTabId = 'raw' | 'highlighted' | 'diff' | 'timestamp' | 'regex';
