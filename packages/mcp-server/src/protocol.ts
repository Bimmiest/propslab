/**
 * Message shapes between the server process and the sandbox worker.
 *
 * Every operation that EXECUTES conf-derived regexes — simulate (the full
 * pipeline), explain (stanza matching runs `[source::…]` / `[host::…]`
 * patterns) — crosses this boundary and runs inside a worker thread the
 * parent can terminate. Validate executes none, but parses and compiles the
 * whole conf, so it runs there too, under the same time and heap limits.
 * Only `lookup_directive`, which reads the static registry, stays in-process.
 */
import type { ConfInput, EventMetadata, ValidationDiagnostic } from '../../../src/engine/types';
import type { SerializedSimulation } from './serialize';
import type { SuspectList } from './suspects';
import type { RegexEngineModule } from '../../../src/utils/splunkRegex';

export interface SimulateRequest {
  op: 'simulate';
  raw: string;
  metadata: EventMetadata;
  propsConf: ConfInput;
  transformsConf: ConfInput;
  perEventPipeline: boolean;
  captureOffsets: boolean;
  /** Serialization happens in the worker, so the result it posts is bounded. */
  maxEvents: number;
  includeSnapshots: boolean;
}

export interface ValidateRequest {
  op: 'validate';
  propsConf: ConfInput;
  transformsConf: ConfInput;
}

export interface ExplainRequest {
  op: 'explain';
  file: 'props.conf' | 'transforms.conf';
  conf: ConfInput;
  /** When present (props.conf only), also resolve stanzas for this event. */
  metadata?: EventMetadata;
}

export type WorkerRequest = SimulateRequest | ValidateRequest | ExplainRequest;

/**
 * What a sandbox worker is started with: its request, the regex engine the
 * server compiled once (see regexEngine.ts), and the shared word it reports
 * its progress in (progress.ts).
 */
export type WorkerData = WorkerRequest & {
  regexEngine: RegexEngineModule;
  progress: SharedArrayBuffer;
};

export type SimulateResponse = SerializedSimulation;

export interface ValidateResponse {
  diagnostics: ValidationDiagnostic[];
  /** Present only when `diagnostics` was cut to fit the response cap. */
  diagnosticCount?: number;
  truncationNote?: string;
}

/** One directive of a stanza, with the layer provenance parseConf attached. */
export interface ExplainDirective {
  key: string;
  value: string;
  line: number;
  layer?: string;
  overrides?: { layer: string; line: number; value: string }[];
  overriddenBy?: { layer: string; line: number; value: string };
}

export interface ExplainStanza {
  name: string;
  type: 'sourcetype' | 'source' | 'host' | 'default';
  lineRange: { start: number; end: number };
  layer?: string;
  layers?: { layer: string; lineRange: { start: number; end: number } }[];
  directives: ExplainDirective[];
  /** Present only when `directives` was cut to fit the response cap. */
  directiveCount?: number;
}

export interface ExplainResponse {
  parseErrors: ValidationDiagnostic[];
  stanzas: ExplainStanza[];
  /** The `…Count` fields are present only when that list was cut to fit the response cap. */
  parseErrorCount?: number;
  stanzaCount?: number;
  truncationNote?: string;
  /** Present only for props.conf when event metadata was supplied. */
  resolution?: {
    metadata: EventMetadata;
    effectiveMetadata: EventMetadata;
    assignedSourcetype?: string;
    /** Highest precedence first — the order `mergeDirectives` consumes. */
    matchedStanzas: { name: string; type: ExplainStanza['type']; layer?: string }[];
    /** The attribute set the event is actually processed with. */
    effectiveDirectives: (ExplainDirective & { stanza: string })[];
    matchedStanzaCount?: number;
    effectiveDirectiveCount?: number;
  };
}

/** The worker's answer: the last message it posts. */
export type WorkerResponse =
  { ok: true; data: SimulateResponse | ValidateResponse | ExplainResponse } | { ok: false; error: string };

/**
 * Posted by a simulate worker before its pipeline runs: the conf's regex
 * directives, for the timeout error should the run not finish. Computed
 * there so that the server never parses caller input on its own thread.
 */
export interface SuspectsMessage {
  kind: 'suspects';
  list: SuspectList;
}

/**
 * Posted once the worker has loaded and instantiated the regex engine, before
 * it touches the request. The run's wall-clock budget starts here, so the
 * worker's start-up — tens of milliseconds warm, over a hundred cold — is not
 * charged to the caller's input.
 */
export interface ReadyMessage {
  kind: 'ready';
}

/** Everything a worker posts: messages about the run so far, then its answer. */
export type WorkerMessage = ReadyMessage | SuspectsMessage | WorkerResponse;
