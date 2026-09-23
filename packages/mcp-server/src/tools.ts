/**
 * The four MCP tools from issue #202, each a thin wrapper over existing engine
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
  WorkerOutOfMemoryError,
  WorkerTimeoutError,
  type RunInWorkerOptions,
} from './runInWorker';
import { serializeResult } from './serialize';
import { collectRegexSuspects } from './suspects';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/** Bounds chosen to comfortably fit real apps while keeping requests sane. */
const MAX_CONF_CHARS = 1_000_000;

const confLayerSchema = z.object({
  layer: z
    .string()
    .max(200)
    .describe('Free-form provenance label, e.g. "default", "local", "myapp/local".'),
  text: z.string().max(MAX_CONF_CHARS).describe('The full text of this conf file.'),
});

const confInputSchema = z
  .union([z.string().max(MAX_CONF_CHARS), z.array(confLayerSchema).max(20)])
  .describe(
    'Either the full text of one flat conf file, or an ordered list of layers ' +
      'LOWEST precedence first (e.g. default/ then local/), each {layer, text}. ' +
      'Layered input adds btool-style provenance to the output: which layer won ' +
      'each attribute, and what it overrode.',
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
      'Record capture spans for positional EXTRACTs. Off by default: nothing here ' +
        'renders highlights, and the `d` regex flag it requires disqualifies ' +
        "patterns from V8's linear-time fallback (docs/engine.md measures 8ms vs 91s).",
    ),
  include_snapshots: z
    .boolean()
    .default(false)
    .describe('Include before/after _raw snapshots on each trace step (verbose).'),
  max_events: z.number().int().min(1).max(500).default(20),
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
  isError?: boolean;
}

function json(payload: unknown, isError = false): ToolText {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Turn a worker failure into something the agent can act on. A timeout gets
 * the regex-suspect list (docs/engine.md's "repair rather than retry blind"),
 * with the caveat that the heuristic is structural and can miss. Running out
 * of the worker's heap gets its own error, so it reads as "too big" rather
 * than as an engine crash.
 */
function workerFailure(
  err: unknown,
  propsConf: ConfInput,
  transformsConf: ConfInput,
): ToolText {
  if (err instanceof WorkerTimeoutError) {
    return json(
      {
        error: 'timeout',
        budget_ms: err.budgetMs,
        message:
          `The run exceeded its ${err.budgetMs}ms wall-clock budget and was hard-terminated. ` +
          'The usual cause is catastrophic regex backtracking in a conf directive.',
        regex_directives: collectRegexSuspects(propsConf, transformsConf),
        guidance:
          'Repair the flagged pattern(s) — start with redos_risk=true, but the heuristic is ' +
          'structural and cannot see forms like (a|aa)+, so an unflagged pattern may still be ' +
          'the cause. Do not simply retry with a larger timeout.',
      },
      true,
    );
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
  const metadata: EventMetadata = {
    index: args.index,
    host: args.host,
    source: args.source,
    sourcetype: args.sourcetype,
  };
  try {
    const { result, diagnostics } = await runInWorker<SimulateResponse>(
      {
        op: 'simulate',
        raw: args.raw,
        metadata,
        propsConf: args.props_conf,
        transformsConf: args.transforms_conf,
        perEventPipeline: args.per_event_pipeline,
        captureOffsets: args.capture_offsets,
      },
      args.timeout_ms,
      worker,
    );
    return json({
      ...serializeResult(result, {
        maxEvents: args.max_events,
        includeSnapshots: args.include_snapshots,
      }),
      diagnostics,
    });
  } catch (err) {
    return workerFailure(err, args.props_conf, args.transforms_conf);
  }
}

export async function handleValidate(args: ValidateArgs, worker?: string | RunInWorkerOptions): Promise<ToolText> {
  try {
    const { diagnostics } = await runInWorker<ValidateResponse>(
      { op: 'validate', propsConf: args.props_conf, transformsConf: args.transforms_conf },
      args.timeout_ms,
      worker,
    );
    return json({ diagnostics });
  } catch (err) {
    return workerFailure(err, args.props_conf, args.transforms_conf);
  }
}

export async function handleExplainPrecedence(
  args: ExplainArgs,
  worker?: string | RunInWorkerOptions,
): Promise<ToolText> {
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
    const empty: ConfInput = '';
    return workerFailure(
      err,
      args.file === 'props.conf' ? args.conf : empty,
      args.file === 'transforms.conf' ? args.conf : empty,
    );
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

export function registerTools(server: McpServer, options?: { workerPath?: string }): void {
  const workerPath = options?.workerPath;

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
    },
    (args) => handleSimulate(args, workerPath),
  );

  server.registerTool(
    'validate',
    {
      title: 'Validate conf text without sample data',
      description:
        'Lint props.conf / transforms.conf text alone: parse errors, unknown or mis-cased ' +
        'keys, values of the wrong type, TRANSFORMS-/REPORT- references to missing stanzas, ' +
        'settings that are inert in the phase they are used in, and directives the simulator ' +
        'does not honour. Use it to check a config you have drafted before simulating it.',
      inputSchema: validateInputShape,
    },
    (args) => handleValidate(args, workerPath),
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
    },
    (args) => handleExplainPrecedence(args, workerPath),
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
    },
    (args) => handleLookupDirective(args),
  );
}
