/**
 * Sandbox worker entry point. The parent holds a wall-clock budget and calls
 * `worker.terminate()` when it expires — hard termination is the mechanism
 * that makes running conf-derived regexes safe (docs/engine.md), and it only
 * works because the regexes execute HERE, on a thread the parent can kill,
 * never on the server's own thread.
 *
 * `./v8Flags` must stay the first import: it arms V8's linear-time regex
 * fallback before the engine's modules load.
 */
import './v8Flags';
import { parentPort, workerData } from 'node:worker_threads';
import { lintConfigs } from '../../../src/engine/configLint';
import { runPipeline } from '../../../src/engine/pipeline';
import { parseConf } from '../../../src/engine/parser/confParser';
import { mergeDirectives, resolveStanzasForEvent } from '../../../src/engine/parser/stanzaMatcher';
import type { ConfDirective, ConfStanza } from '../../../src/engine/types';
import type {
  ExplainDirective,
  ExplainRequest,
  ExplainResponse,
  ExplainStanza,
  SimulateRequest,
  SimulateResponse,
  ValidateRequest,
  ValidateResponse,
  WorkerRequest,
  WorkerResponse,
} from './protocol';
import { lintRegexDirectives } from './regexLint';
import { serializeSimulation } from './serialize';

/**
 * Serialized here rather than on the server's thread: the raw ProcessingResult
 * grows with the event count, and posting it whole put all of it on the main
 * thread, which has no heap limit, before anything was trimmed (#351).
 */
function handleSimulate(request: SimulateRequest): SimulateResponse {
  const { result, diagnostics } = runPipeline(
    request.raw,
    request.metadata,
    request.propsConf,
    request.transformsConf,
    { perEventPipeline: request.perEventPipeline, captureOffsets: request.captureOffsets },
  );
  return serializeSimulation(result, diagnostics, {
    maxEvents: request.maxEvents,
    includeSnapshots: request.includeSnapshots,
  });
}

/**
 * The same parse and config lint `runPipeline` runs first, plus a compile of
 * every stanza's regexes. No pipeline run: validate used to push a dummy
 * event through one, which reported a bad regex only in stanzas that event
 * happened to match, and let diagnostics about the dummy event itself out
 * through `[default]` and `[host::…]` stanzas (#360).
 */
function handleValidate(request: ValidateRequest): ValidateResponse {
  const propsConf = parseConf(request.propsConf, 'props.conf');
  const transformsConf = parseConf(request.transformsConf, 'transforms.conf');
  const diagnostics = [...propsConf.errors, ...transformsConf.errors];
  lintConfigs(propsConf, transformsConf, diagnostics);
  diagnostics.push(...lintRegexDirectives(propsConf, transformsConf));
  return { diagnostics };
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

function handleExplain(request: ExplainRequest): ExplainResponse {
  const parsed = parseConf(request.conf, request.file);
  const response: ExplainResponse = {
    parseErrors: parsed.errors,
    stanzas: parsed.stanzas.map(toExplainStanza),
  };

  if (request.file === 'props.conf' && request.metadata) {
    const resolved = resolveStanzasForEvent(parsed.stanzas, request.metadata);
    const merged = mergeDirectives(resolved.stanzas);
    // mergeDirectives returns the winning ConfDirective objects themselves, so
    // the stanza each winner came from is recoverable by identity.
    const stanzaOf = (directive: ConfDirective): string =>
      resolved.stanzas.find((s) => s.directives.includes(directive))?.name ?? 'default';
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

  return response;
}

function handle(request: WorkerRequest) {
  switch (request.op) {
    case 'simulate':
      return handleSimulate(request);
    case 'validate':
      return handleValidate(request);
    case 'explain':
      return handleExplain(request);
  }
}

const port = parentPort;
if (port) {
  let response: WorkerResponse;
  try {
    response = { ok: true, data: handle(workerData as WorkerRequest) };
  } catch (err) {
    response = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(response);
}
