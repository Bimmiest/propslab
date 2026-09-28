// ---------------------------------------------------------------------------
// runContext.ts
// The state one pipeline run shares across its stages.
//
// Stages used to take `now` and the diagnostics list as optional positional
// parameters defaulting to `Date.now()` and a fresh array, so a call site that
// dropped one got a silently different result (#416), and each stage kept its
// own "already warned" sets, which forgot between calls (#418). `runPipeline`
// builds one of these and every stage reads its run state from it.
// ---------------------------------------------------------------------------

import type { ValidationDiagnostic } from './types';

/** Anything diagnostics can be pushed into: a plain array or a collector. */
export interface DiagnosticSink {
  push(...diagnostics: ValidationDiagnostic[]): unknown;
}

/** Bounds on how much work one run does. */
export interface RunLimits {
  /** Input past this many characters is cut back to the last line break. */
  readonly maxRawChars: number;
}

export const DEFAULT_LIMITS: RunLimits = Object.freeze({
  maxRawChars: 1_000_000,
});

/**
 * The run's diagnostics. `push` appends; `once` is the run-wide "already
 * reported" ledger, so a warning keyed on a stanza or field is raised once per
 * run however many events or stage calls reach it.
 */
export interface DiagnosticsCollector extends DiagnosticSink {
  push(...diagnostics: ValidationDiagnostic[]): void;
  /** True the first time `key` is seen in this run, false after. */
  once(key: string): boolean;
  /** Push `diagnostic` unless `key` was already reported in this run. */
  report(key: string, diagnostic: ValidationDiagnostic): void;
  /** Everything pushed so far, in order. */
  readonly list: readonly ValidationDiagnostic[];
  /**
   * A view that writes into this collector and shares its ledger, but drops a
   * diagnostic identical in everything a reader sees to one this view (or
   * `seed`) already holds. For stages called once per event, where a
   * config-level problem would otherwise be reported once per event.
   */
  deduplicating(seed?: readonly ValidationDiagnostic[]): DiagnosticsCollector;
}

function visibleKey(d: ValidationDiagnostic): string {
  return `${d.level}|${d.file}|${d.layer ?? ''}|${d.line ?? ''}|${d.directiveKey ?? ''}|${d.message}`;
}

function makeCollector(
  sink: ValidationDiagnostic[],
  keys: Set<string>,
  visible: Set<string> | undefined,
): DiagnosticsCollector {
  const collector: DiagnosticsCollector = {
    push(...diagnostics) {
      for (const d of diagnostics) {
        if (visible) {
          const key = visibleKey(d);
          if (visible.has(key)) continue;
          visible.add(key);
        }
        sink.push(d);
      }
    },
    once(key) {
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
    report(key, diagnostic) {
      if (collector.once(key)) collector.push(diagnostic);
    },
    get list() {
      return sink;
    },
    deduplicating(seed = []) {
      return makeCollector(sink, keys, new Set(seed.map(visibleKey)));
    },
  };
  return collector;
}

/** A collector over `sink`, which it appends to (a fresh array by default). */
export function createCollector(sink: ValidationDiagnostic[] = []): DiagnosticsCollector {
  return makeCollector(sink, new Set(), undefined);
}

export interface RunContext {
  /**
   * The run's clock, in epoch ms, read once so every stage agrees on it. See
   * `PipelineOptions.now`.
   */
  readonly now: number;
  /** Keep capture spans for positional EXTRACTs. See `PipelineOptions.captureOffsets`. */
  readonly captureOffsets: boolean;
  readonly diagnostics: DiagnosticsCollector;
  readonly limits: RunLimits;
}

export interface RunContextInit {
  now: number;
  captureOffsets?: boolean;
  /** Where diagnostics go; a fresh array when omitted. */
  diagnostics?: ValidationDiagnostic[];
  limits?: Partial<RunLimits>;
}

export function createRunContext(init: RunContextInit): RunContext {
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...init.limits });
  return Object.freeze({
    now: init.now,
    captureOffsets: init.captureOffsets ?? true,
    diagnostics: createCollector(init.diagnostics),
    limits,
  });
}

/** The same run, with diagnostics going through `diagnostics` instead. */
export function withDiagnostics(ctx: RunContext, diagnostics: DiagnosticsCollector): RunContext {
  return Object.freeze({ ...ctx, diagnostics });
}

/**
 * A context for replaying stages whose output is kept but whose diagnostics
 * are not: it reports nowhere.
 */
export function replayContext(ctx: RunContext): RunContext {
  return createRunContext({
    now: ctx.now,
    captureOffsets: false,
    limits: ctx.limits,
  });
}
