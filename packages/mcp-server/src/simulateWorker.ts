/**
 * Sandbox worker entry point. The parent holds a wall-clock budget and calls
 * `worker.terminate()` when it expires. Conf-derived regexes run on PCRE2,
 * whose match limits bound each match; termination bounds the whole run
 * (docs/engine.md), and it only works because the regexes execute HERE, on a
 * thread the parent can kill, never on the server's own thread.
 *
 * `./v8Flags` must stay the first import: it arms V8's linear-time regex
 * fallback, for the engine's own JS regexes, before the engine's modules load.
 */
import './v8Flags';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { lintConfigs } from '../../../src/engine/configLint';
import { runPipeline } from '../../../src/engine/pipeline';
import { parseConf } from '../../../src/engine/parser/confParser';
import { mergeDirectives, resolveStanzasForEvent } from '../../../src/engine/parser/stanzaMatcher';
import type { ConfDirective, ConfStanza } from '../../../src/engine/types';
import { initRegexEngineSync } from '../../../src/utils/splunkRegex';
import type {
  ExplainDirective,
  ExplainRequest,
  ExplainResponse,
  ExplainStanza,
  SimulateRequest,
  ReadyMessage,
  SimulateResponse,
  SuspectsMessage,
  ValidateRequest,
  WorkerData,
  ValidateResponse,
  WorkerRequest,
  WorkerResponse,
} from './protocol';
import { lintRegexDirectives } from './regexLint';
import { boundExplain, boundValidate } from './responseBudget';
import { serializeSimulation } from './serialize';
import { boundedRegexSuspects } from './suspects';
import { progressWriter, type ProgressWriter } from './progress';

/** What a handler reports through while it runs. */
interface Run {
  port: MessagePort;
  progress: ProgressWriter;
}

/**
 * Serialized here rather than on the server's thread: the raw ProcessingResult
 * grows with the event count, and posting it whole would put all of it on the
 * main thread, which has no heap limit, before anything was trimmed. Validate
 * and explain are cut to the same response budget here for the same reason.
 *
 * The regex-suspect list is posted first, for the timeout error should the
 * run not finish (suspects.ts). It costs a second parse of the conf, linear
 * and a small share of any run long enough to time out; in exchange the
 * server's thread never parses caller input. Validate and explain post none:
 * neither runs a directive's regex, so a regex is not what makes them slow.
 */
function handleSimulate(request: SimulateRequest, run: Run): SimulateResponse {
  run.progress.phase('parsing');
  const suspects: SuspectsMessage = {
    kind: 'suspects',
    list: boundedRegexSuspects(request.propsConf, request.transformsConf),
  };
  run.port.postMessage(suspects);
  const { result, diagnostics } = runPipeline(
    request.raw,
    request.metadata,
    request.propsConf,
    request.transformsConf,
    {
      perEventPipeline: request.perEventPipeline,
      captureOffsets: request.captureOffsets,
      onStage: run.progress.stage,
    },
  );
  run.progress.phase('finishing');
  return serializeSimulation(result, diagnostics, {
    maxEvents: request.maxEvents,
    includeSnapshots: request.includeSnapshots,
  });
}

/**
 * The same parse and config lint `runPipeline` runs first, plus a compile of
 * every stanza's regexes. No pipeline run: a dummy event would report a bad
 * regex only in stanzas it happened to match, and diagnostics about the dummy
 * event itself would leak out through `[default]` and `[host::…]` stanzas.
 */
function handleValidate(request: ValidateRequest, run: Run): ValidateResponse {
  run.progress.phase('parsing');
  const propsConf = parseConf(request.propsConf, 'props.conf');
  const transformsConf = parseConf(request.transformsConf, 'transforms.conf');
  const diagnostics = [...propsConf.errors, ...transformsConf.errors];
  run.progress.phase('running');
  lintConfigs(propsConf, transformsConf, diagnostics);
  diagnostics.push(...lintRegexDirectives(propsConf, transformsConf));
  run.progress.phase('finishing');
  return boundValidate(diagnostics);
}

function toExplainDirective(d: ConfDirective): ExplainDirective {
  return {
    key: d.key,
    value: d.value,
    line: d.line,
    ...(d.layer !== undefined ? { layer: d.layer } : {}),
    ...(d.overrides !== undefined ? { overrides: d.overrides } : {}),
    ...(d.overriddenBy !== undefined ? { overriddenBy: d.overriddenBy } : {}),
  };
}

function toExplainStanza(s: ConfStanza): ExplainStanza {
  return {
    name: s.name,
    type: s.type,
    lineRange: s.lineRange,
    ...(s.layer !== undefined ? { layer: s.layer } : {}),
    ...(s.layers !== undefined ? { layers: s.layers } : {}),
    directives: s.directives.map(toExplainDirective),
  };
}

function handleExplain(request: ExplainRequest, run: Run): ExplainResponse {
  run.progress.phase('parsing');
  const parsed = parseConf(request.conf, request.file);
  run.progress.phase('running');
  const response: ExplainResponse = {
    parseErrors: parsed.errors,
    stanzas: parsed.stanzas.map(toExplainStanza),
  };

  if (request.file === 'props.conf' && request.metadata) {
    const resolved = resolveStanzasForEvent(parsed.stanzas, request.metadata);
    const merged = mergeDirectives(resolved.stanzas);
    // mergeDirectives returns the winning ConfDirective objects themselves, so
    // the stanza each winner came from is recoverable by identity — through a
    // map, as a scan per winner is quadratic in a stanza of 200k directives.
    const owner = new Map<ConfDirective, string>();
    for (const s of resolved.stanzas) {
      for (const d of s.directives) if (!owner.has(d)) owner.set(d, s.name);
    }
    const stanzaOf = (directive: ConfDirective): string => owner.get(directive) ?? 'default';
    response.resolution = {
      metadata: request.metadata,
      effectiveMetadata: resolved.metadata,
      ...(resolved.assignedSourcetype ? { assignedSourcetype: resolved.assignedSourcetype } : {}),
      matchedStanzas: resolved.stanzas.map((s) => ({
        name: s.name,
        type: s.type,
        ...(s.layer !== undefined ? { layer: s.layer } : {}),
      })),
      effectiveDirectives: merged.map((d) => ({ ...toExplainDirective(d), stanza: stanzaOf(d) })),
    };
  }

  run.progress.phase('finishing');
  return boundExplain(response);
}

function handle(request: WorkerRequest, run: Run) {
  switch (request.op) {
    case 'simulate':
      return handleSimulate(request, run);
    case 'validate':
      return handleValidate(request, run);
    case 'explain':
      return handleExplain(request, run);
  }
}

const port = parentPort;
if (port) {
  let response: WorkerResponse;
  try {
    const { regexEngine, progress, ...request } = workerData as WorkerData;
    initRegexEngineSync(regexEngine);
    // Start-up is over: the modules are loaded and the regex engine is
    // instantiated. The server starts the run's budget on this message.
    const ready: ReadyMessage = { kind: 'ready' };
    port.postMessage(ready);
    response = { ok: true, data: handle(request, { port, progress: progressWriter(progress) }) };
  } catch (err) {
    response = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(response);
}
