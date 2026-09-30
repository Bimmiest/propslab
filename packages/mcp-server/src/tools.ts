/**
 * The four MCP tools, each a thin wrapper over existing engine
 * exports. Handlers are exported separately from `registerTools` so tests can
 * call them without a transport.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getCanonicalDirectiveKey,
  getClassBasedDirectiveBase,
  getDirectiveInfo,
  getDirectivesForFile,
} from '../../../src/engine/directiveRegistry';
import type { ConfInput, EventMetadata } from '../../../src/engine/types';
import type { ExplainResponse, SimulateResponse, ValidateResponse } from './protocol';
import {
  runInWorker,
  WorkerBusyError,
  WorkerCancelledError,
  WorkerOutOfMemoryError,
  WorkerTimeoutError,
  type RunInWorkerOptions,
} from './runInWorker';
import {
  CAP_NOTE,
  cutNote,
  cutToFit,
  jsonResponseBytes,
  MAX_PAYLOAD_BYTES,
  MAX_RESPONSE_BYTES,
} from './responseBudget';
import {
  explainOutputShape,
  lookupOutputShape,
  simulateOutputShape,
  validateOutputShape,
} from './outputSchemas';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/** Bounds chosen to comfortably fit real apps while keeping requests sane. */
const MAX_CONF_CHARS = 1_000_000;
const MAX_CONF_LAYERS = 20;

/**
 * Total conf text one call may carry: every layer of props.conf and
 * transforms.conf together. The per-field limits alone admit twenty
 * layers of a million characters for each file — forty million characters —
 * which the worker's heap limit is not sized for (runInWorker.ts sizes it
 * from the sample), and which simulate's worker parses twice (once for the
 * timeout error's regex suspects). Two million is still several times the
 * largest real props.conf + transforms.conf pair, default and local together.
 *
 * Enforced in two places: `confInputSchema` refuses one conf over it during
 * validation, and `confTooLarge` refuses the two files' sum in the handlers,
 * since a raw zod shape (what `registerTool` takes) cannot refine across
 * fields.
 */
export const MAX_TOTAL_CONF_CHARS = 2_000_000;

/** Characters of conf text in one input, summed across its layers. */
export function confChars(conf: ConfInput): number {
  return typeof conf === 'string' ? conf.length : conf.reduce((n, l) => n + l.text.length, 0);
}

/**
 * The structured refusal for conf text over `MAX_TOTAL_CONF_CHARS`, or null
 * when it fits. Checked before a worker slot is taken, so an oversized call
 * neither queues nor reaches a worker.
 */
function confTooLarge(...confs: ConfInput[]): ToolText | null {
  const total = confs.reduce((n, c) => n + confChars(c), 0);
  if (total <= MAX_TOTAL_CONF_CHARS) return null;
  return json(
    {
      error: 'input_too_large',
      conf_chars: total,
      max_conf_chars: MAX_TOTAL_CONF_CHARS,
      message:
        `The conf text totals ${total} characters across all layers and files; ` +
        `the limit is ${MAX_TOTAL_CONF_CHARS}.`,
      guidance:
        'Send only the stanzas that matter for this question — the ones matching the ' +
        'sourcetype/source/host under test, and the transforms they reference.',
    },
    true,
  );
}

const confLayerSchema = z.object({
  layer: z
    .string()
    .max(200)
    .describe('Free-form provenance label, e.g. "default", "local", "myapp/local".'),
  text: z.string().max(MAX_CONF_CHARS).describe('The full text of this conf file.'),
});

const confInputSchema = z
  .union([z.string().max(MAX_CONF_CHARS), z.array(confLayerSchema).max(MAX_CONF_LAYERS)])
  .refine((conf) => confChars(conf) <= MAX_TOTAL_CONF_CHARS, {
    message: `Conf text across all layers must total at most ${MAX_TOTAL_CONF_CHARS} characters`,
  })
  .describe(
    'Either the full text of one flat conf file, or an ordered list of layers ' +
      'LOWEST precedence first (e.g. default/ then local/), each {layer, text}. ' +
      'Layered input adds btool-style provenance to the output: which layer won ' +
      'each attribute, and what it overrode. props_conf and transforms_conf ' +
      `together may total at most ${MAX_TOTAL_CONF_CHARS} characters across all layers.`,
  );

const metadataShape = {
  sourcetype: z
    .string()
    .min(1)
    .max(1024)
    .describe('Event sourcetype — decides which [stanza] entries in props.conf match.'),
  index: z.string().max(1024).default('main'),
  host: z.string().max(1024).default('localhost'),
  source: z
    .string()
    .max(1024)
    .default('/var/log/sample.log')
    .describe('Source path — [source::…] stanzas match against it.'),
};

const timeoutSchema = z
  .number()
  .int()
  .min(100)
  .max(30_000)
  .default(5_000)
  .describe(
    'Wall-clock budget in ms for the sandboxed engine run. On expiry the worker ' +
      'thread is hard-terminated and a structured timeout error is returned. The ' +
      'budget starts when the run starts; time spent queued behind other calls ' +
      '(a few run at once) does not count against it.',
  );

const fileSchema = z.enum(['props.conf', 'transforms.conf']);

export const simulateInputShape = {
  raw: z
    .string()
    .min(1)
    .max(1_000_000)
    .describe('Sample event data to run through the pipeline (one or more raw log lines).'),
  ...metadataShape,
  props_conf: confInputSchema.default(''),
  transforms_conf: confInputSchema.default(''),
  per_event_pipeline: z
    .boolean()
    .default(false)
    .describe(
      'Resolve stanzas per event rather than once for the batch, so metadata ' +
        'rewritten mid-pipeline (e.g. a sourcetype-renaming transform) takes ' +
        'effect for downstream processors.',
    ),
  capture_offsets: z
    .boolean()
    .default(false)
    .describe(
      "Record capture spans for positional EXTRACTs in each event's fieldOffsets. " +
        'Off by default: nothing here renders highlights. PCRE2 reports the spans ' +
        'with every match anyway, so this costs output size, not matching time.',
    ),
  include_snapshots: z
    .boolean()
    .default(false)
    .describe('Include before/after _raw snapshots on each trace step (verbose).'),
  max_events: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(20)
    .describe(
      'Most events to return; processingSteps covers the returned events only. The whole ' +
        `response is also capped at ${MAX_RESPONSE_BYTES} bytes, and returns fewer ` +
        'events when they would not fit — truncationNote says when either cut applies.',
    ),
  timeout_ms: timeoutSchema,
};

export const validateInputShape = {
  props_conf: confInputSchema.default(''),
  transforms_conf: confInputSchema.default(''),
  timeout_ms: timeoutSchema,
};

export const explainInputShape = {
  file: fileSchema
    .default('props.conf')
    .describe('Which conf file the input text is.'),
  conf: confInputSchema,
  sourcetype: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      'props.conf only: also resolve which stanzas match an event with this ' +
        'sourcetype and return the effective merged directive set for it.',
    ),
  index: z.string().max(1024).default('main'),
  host: z.string().max(1024).default('localhost'),
  source: z.string().max(1024).default('/var/log/sample.log'),
  timeout_ms: timeoutSchema,
};

export const lookupInputShape = {
  key: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Directive key, e.g. "LINE_BREAKER" or a class-based key like "EXTRACT-foo". ' +
        'Omit to list every known directive instead.',
    ),
  file: fileSchema
    .optional()
    .describe('Restrict the lookup to one conf file; omitted = search both.'),
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface ToolText {
  // The index signature matches the SDK's CallToolResult, which the handler
  // return type must be assignable to.
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * A success carries the payload twice: as `structuredContent` for clients
 * that read the output schema, and as compact JSON text for those that do
 * not. Both come from the one object, and the response budget
 * (responseBudget.ts) counts both, in bytes; the worker cuts each payload to
 * it. What still comes out over it — which the worker's cuts should make
 * impossible — is refused here rather than written.
 *
 * An error omits `structuredContent`: its payload does not match the output
 * schema, and the SDK client validates `structuredContent` whenever present,
 * error or not. The error JSON stays in the text.
 */
function json(payload: object, isError = false): ToolText {
  const text = JSON.stringify(payload);
  const bytes = jsonResponseBytes(text);
  if (bytes > MAX_PAYLOAD_BYTES) {
    return json(
      {
        error: 'response_too_large',
        response_bytes: bytes,
        max_response_bytes: MAX_RESPONSE_BYTES,
        message: `The response would be ${bytes} bytes. ${CAP_NOTE}`,
        guidance: 'Send a smaller sample or conf, or ask for less (max_events, include_snapshots).',
      },
      true,
    );
  }
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : { structuredContent: payload as Record<string, unknown> }),
  };
}

/**
 * The timeout error, with the regex-suspect list the worker posted before its
 * run, cut to the response budget: one suspect per regex directive, so a conf
 * of many large patterns lists megabytes of them. Flagged patterns sort first
 * and survive the cut. Only a simulate run posts a list, and only once it has
 * parsed the conf; without one the error names no regex.
 */
function timeoutFailure(err: WorkerTimeoutError): ToolText {
  const base = {
    error: 'timeout',
    budget_ms: err.budgetMs,
  };
  if (!err.suspects) {
    return json(
      {
        ...base,
        message:
          `The run exceeded its ${err.budgetMs}ms wall-clock budget and was hard-terminated ` +
          'before it ran any regex directive.',
        guidance:
          'Send less conf text — only the stanzas that matter for this question — or a larger ' +
          'timeout_ms.',
      },
      true,
    );
  }
  const { suspects, total } = err.suspects;
  return json(
    cutToFit(suspects, (kept) => ({
      ...base,
      message:
        `The run exceeded its ${err.budgetMs}ms wall-clock budget and was hard-terminated. ` +
        'The usual cause is a regex backtracking heavily on every event, or one whose stanza ' +
        'disables PCRE\'s limits with MATCH_LIMIT = 0.',
      regex_directives: suspects.slice(0, kept),
      ...(kept < total
        ? {
            regex_directive_count: total,
            truncation_note: `${cutNote('regex directives', kept, total)} ${CAP_NOTE}`,
          }
        : {}),
      guidance:
        'Repair the flagged pattern(s) — start with redos_risk=true, but the heuristic is ' +
        'structural and cannot see forms like (a|aa)+, so an unflagged pattern may still be ' +
        'the cause. Do not simply retry with a larger timeout.',
    })),
    true,
  );
}

/**
 * Turn a worker failure into something the agent can act on. A timeout gets
 * the regex-suspect list (docs/engine.md's "repair rather than retry blind"),
 * with the caveat that the heuristic is structural and can miss. Running out
 * of the worker's heap gets its own error, so it reads as "too big" rather
 * than as an engine crash.
 */
function workerFailure(err: unknown): ToolText {
  if (err instanceof WorkerTimeoutError) {
    return timeoutFailure(err);
  }
  if (err instanceof WorkerOutOfMemoryError) {
    // No regex-suspect list here: memory is exhausted by volume — how much
    // sample went in, how many events and fields came out, snapshots — far
    // more often than by any one pattern, and pointing at regexes would send
    // the agent after the wrong thing.
    return json(
      {
        error: 'out_of_memory',
        heap_limit_mb: err.limits.maxOldGenerationSizeMb,
        message:
          `The run exceeded the sandbox's ${err.limits.maxOldGenerationSizeMb}MB heap limit and ` +
          'was terminated. The server itself is unaffected.',
        guidance:
          'Reduce what the run has to hold: a smaller raw sample, include_snapshots=false, ' +
          'fewer layers, or a LINE_BREAKER that splits the sample into more than one huge ' +
          'event. The limit is fixed; retrying the same input will fail the same way.',
      },
      true,
    );
  }
  if (err instanceof WorkerBusyError) {
    // Refused before queuing: the input may be fine, the server is
    // just full. Said plainly so the agent waits rather than edits its conf.
    return json(
      {
        error: 'busy',
        max_concurrent: err.maxConcurrent,
        max_queued: err.maxQueued,
        message: err.message,
        guidance:
          'Nothing is wrong with the input. Wait for in-flight calls to finish and retry; ' +
          'issue fewer calls at once.',
      },
      true,
    );
  }
  if (err instanceof WorkerCancelledError) {
    // Over MCP nobody reads this: the SDK drops the response to a cancelled
    // request. It exists for direct callers of the handlers, and so a
    // cancellation is never mistaken for an engine failure in a log.
    return json(
      {
        error: 'cancelled',
        started: err.started,
        message: err.message,
      },
      true,
    );
  }
  return json(
    { error: 'engine_failure', message: err instanceof Error ? err.message : String(err) },
    true,
  );
}

type SimulateArgs = z.infer<z.ZodObject<typeof simulateInputShape>>;
type ValidateArgs = z.infer<z.ZodObject<typeof validateInputShape>>;
type ExplainArgs = z.infer<z.ZodObject<typeof explainInputShape>>;
type LookupArgs = z.infer<z.ZodObject<typeof lookupInputShape>>;

export async function handleSimulate(args: SimulateArgs, worker?: string | RunInWorkerOptions): Promise<ToolText> {
  const tooLarge = confTooLarge(args.props_conf, args.transforms_conf);
  if (tooLarge) return tooLarge;
  const metadata: EventMetadata = {
    index: args.index,
    host: args.host,
    source: args.source,
    sourcetype: args.sourcetype,
  };
  try {
    const response = await runInWorker<SimulateResponse>(
      {
        op: 'simulate',
        raw: args.raw,
        metadata,
        propsConf: args.props_conf,
        transformsConf: args.transforms_conf,
        perEventPipeline: args.per_event_pipeline,
        captureOffsets: args.capture_offsets,
        maxEvents: args.max_events,
        includeSnapshots: args.include_snapshots,
      },
      args.timeout_ms,
      worker,
    );
    return json(response);
  } catch (err) {
    return workerFailure(err);
  }
}

export async function handleValidate(args: ValidateArgs, worker?: string | RunInWorkerOptions): Promise<ToolText> {
  const tooLarge = confTooLarge(args.props_conf, args.transforms_conf);
  if (tooLarge) return tooLarge;
  try {
    const response = await runInWorker<ValidateResponse>(
      { op: 'validate', propsConf: args.props_conf, transformsConf: args.transforms_conf },
      args.timeout_ms,
      worker,
    );
    return json(response);
  } catch (err) {
    return workerFailure(err);
  }
}

export async function handleExplainPrecedence(
  args: ExplainArgs,
  worker?: string | RunInWorkerOptions,
): Promise<ToolText> {
  // The schema already refuses one conf over the limit; checked again for
  // direct callers of the handler, which skip the schema.
  const tooLarge = confTooLarge(args.conf);
  if (tooLarge) return tooLarge;
  const metadata: EventMetadata | undefined =
    args.file === 'props.conf' && args.sourcetype
      ? { index: args.index, host: args.host, source: args.source, sourcetype: args.sourcetype }
      : undefined;
  try {
    const response = await runInWorker<ExplainResponse>(
      { op: 'explain', file: args.file, conf: args.conf, ...(metadata ? { metadata } : {}) },
      args.timeout_ms,
      worker,
    );
    return json(response);
  } catch (err) {
    return workerFailure(err);
  }
}

export function handleLookupDirective(args: LookupArgs): ToolText {
  const files: ('props.conf' | 'transforms.conf')[] = args.file
    ? [args.file]
    : ['props.conf', 'transforms.conf'];

  if (!args.key) {
    const listing = Object.fromEntries(
      files.map((file) => [
        file,
        getDirectivesForFile(file).map((d) => ({
          key: d.key,
          category: d.category,
          phase: d.phase,
          valueType: d.valueType,
          support: d.support,
        })),
      ]),
    );
    return json(listing);
  }

  const matches = files.flatMap((file) => {
    const info = getDirectiveInfo(args.key as string, file);
    return info ? [{ file, ...info }] : [];
  });
  if (matches.length > 0) {
    const classBased = getClassBasedDirectiveBase(args.key);
    return json({
      matches,
      ...(classBased
        ? { classBased: { base: classBased.base, className: classBased.className } }
        : {}),
    });
  }

  // No match — Splunk attribute names are case-sensitive and a mis-cased key
  // is silently ignored, so the case-typo suggestion is the useful answer.
  const suggestions = files.flatMap((file) => {
    const canonical = getCanonicalDirectiveKey(args.key as string, file);
    return canonical ? [{ file, canonical }] : [];
  });
  return json(
    {
      error: 'unknown_directive',
      key: args.key,
      ...(suggestions.length > 0
        ? {
            suggestions,
            note:
              'Splunk attribute names are case-sensitive; a mis-cased name is silently ' +
              'ignored and the default applies.',
          }
        : { note: 'No registry entry matches this key, exactly or case-insensitively.' }),
    },
    true,
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Every tool only reads its input and the static registry: nothing is
 * written, nothing outside the process is reached, and the same input gives
 * the same answer — so clients need not confirm a call before running it.
 */
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerTools(server: McpServer, options?: { workerPath?: string }): void {
  const workerPath = options?.workerPath;
  // Each call carries its own request's cancellation signal, so a cancelled
  // (or disconnected) request frees its concurrency slot — see runInWorker.
  const worker = (extra: { signal: AbortSignal }): RunInWorkerOptions => ({
    workerPath,
    signal: extra.signal,
  });

  server.registerTool(
    'simulate',
    {
      title: 'Simulate the Splunk processing pipeline',
      description:
        "Run sample log data through a faithful simulation of Splunk's props.conf/" +
        'transforms.conf index-time and search-time pipeline. Returns per-event _time, ' +
        'fields, indexed fields, and a processingTrace naming every processor that touched ' +
        'the event, plus config diagnostics. Use this to VERIFY what a config actually does ' +
        'to real data instead of predicting it; read the diagnostics too — they name ' +
        'directives the simulator recognises but does not honour.',
      inputSchema: simulateInputShape,
      outputSchema: simulateOutputShape,
      annotations,
    },
    (args, extra) => handleSimulate(args, worker(extra)),
  );

  server.registerTool(
    'validate',
    {
      title: 'Validate conf text without sample data',
      description:
        'Lint props.conf / transforms.conf text alone: parse errors, unknown or mis-cased ' +
        'keys, values of the wrong type, TRANSFORMS-/REPORT- references to missing stanzas, ' +
        'settings that are inert in the phase they are used in, directives the simulator ' +
        'does not honour, and regexes (in every stanza) that PCRE will not compile. Use it to ' +
        'check a config you have drafted before simulating it.',
      inputSchema: validateInputShape,
      outputSchema: validateOutputShape,
      annotations,
    },
    (args, extra) => handleValidate(args, worker(extra)),
  );

  server.registerTool(
    'explain_precedence',
    {
      title: 'Explain layered-conf precedence (btool-style)',
      description:
        'Parse one conf file — optionally as ordered default/local layers — and report every ' +
        'stanza with full provenance: which layer defines it, and for each attribute which ' +
        'definition won (`overrides`) and which lost (`overriddenBy`). For props.conf, pass a ' +
        'sourcetype to also resolve which stanzas match such an event and get the effective ' +
        'merged directive set, i.e. what `btool props list --debug` would answer.',
      inputSchema: explainInputShape,
      outputSchema: explainOutputShape,
      annotations,
    },
    (args, extra) => handleExplainPrecedence(args, worker(extra)),
  );

  server.registerTool(
    'lookup_directive',
    {
      title: 'Look up directive documentation',
      description:
        'Curated registry entry for a props.conf/transforms.conf directive: description, ' +
        'example, default, value type, phase (index-time/search-time), deprecation, and ' +
        'crucially the simulation-support level (simulated/ignored/documented). Cite this ' +
        'instead of recalling Splunk documentation from memory. Omit `key` to list all ' +
        'known directives.',
      inputSchema: lookupInputShape,
      outputSchema: lookupOutputShape,
      annotations,
    },
    (args) => handleLookupDirective(args),
  );
}
