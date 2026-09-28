/**
 * Every user-written pattern — LINE_BREAKER, BREAK_ONLY_BEFORE, TIME_PREFIX,
 * EXTRACT, REGEX, SEDCMD, FIELD_HEADER_REGEX, eval's match()/replace(), and
 * the editor's checks of all of them — compiles here, onto PCRE2 running as
 * WebAssembly (the pcre2-wasm-utf16 package). Splunk's regexes are PCRE, so this is the
 * engine Splunk runs rather than a translation into JavaScript, and since the
 * pipeline, the editor and the MCP server all come through this one door they
 * cannot disagree about what a pattern means.
 *
 * Replacement syntax is not PCRE2's: Splunk exposes no pcre2_substitute, and
 * each directive (SEDCMD, FORMAT, eval replace()) expands its own template
 * from the match's groups.
 *
 * The engine needs {@link initRegexEngine} (or the Sync form) once before the
 * first pattern compiles; see docs/engine.md.
 */

import {
  getModule,
  init,
  initSync,
  isReady,
  Regex as Pcre2Regex,
  RegexMatchError,
  RegexSyntaxError,
  type CompiledModule,
  type Match,
  type ModuleBytes,
} from 'pcre2-wasm-utf16';

export type RegexMatch = Match;
export type RegexEngineModule = CompiledModule;

/**
 * Instantiate the regex engine from its module (compiled or bytes). Calling it
 * again replaces the instance, and with it every compiled pattern: the cache is
 * emptied so nothing compiled against the old memory is run against the new.
 */
export async function initRegexEngine(
  source: CompiledModule | ModuleBytes | PromiseLike<CompiledModule | ModuleBytes>,
): Promise<void> {
  await init(source);
  cache.clear();
  probeCache.clear();
}

/** {@link initRegexEngine}, synchronously: for workers and Node. */
export function initRegexEngineSync(source: CompiledModule | ModuleBytes): void {
  initSync(source);
  cache.clear();
  probeCache.clear();
}

export const isRegexEngineReady: () => boolean = isReady;

/** The compiled module, to hand to a worker so it need not compile its own. */
export const regexEngineModule: () => CompiledModule = getModule;

/** Escape a literal string for use inside a regex (PCRE or JS). */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MATCH_LIMIT and DEPTH_LIMIT, as PCRE2's match and depth limits. Absent
 * means PCRE2's own defaults, which is what patterns outside field extraction
 * get.
 */
export interface RegexLimits {
  matchLimit?: number;
  depthLimit?: number;
}

/** Splunk's defaults for MATCH_LIMIT and DEPTH_LIMIT (props.conf.spec, transforms.conf.spec). */
export const DEFAULT_MATCH_LIMIT = 100000;
export const DEFAULT_DEPTH_LIMIT = 1000;

function parseLimit(value: string | undefined, fallback: number): number {
  const text = value?.trim();
  // Blank resets to the default, as directiveLint says; Number('') would be 0,
  // i.e. no limit. Negative or non-numeric is unset too, and linted.
  if (!text || !/^\d+$/.test(text)) return fallback;
  const n = Number(text);
  // 0 is "no limit" in the spec.
  return n === 0 ? 0xffffffff : n;
}

/**
 * The limits a field extraction runs under, from the MATCH_LIMIT and
 * DEPTH_LIMIT values in its stanza (props.conf for EXTRACT, the transform's own
 * stanza for REPORT and TRANSFORMS).
 */
export function extractionLimits(matchLimit?: string, depthLimit?: string): RegexLimits {
  return {
    matchLimit: parseLimit(matchLimit, DEFAULT_MATCH_LIMIT),
    depthLimit: parseLimit(depthLimit, DEFAULT_DEPTH_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Compiled-pattern cache
//
// Compiled code lives in wasm memory, which no garbage collector sees, so the
// patterns are held in a bounded LRU and freed on eviction. A SplunkRegex does
// not hold one: it looks its code up here on every call and recompiles it if
// it was evicted, so eviction never leaves a caller holding freed memory.
// ---------------------------------------------------------------------------

/**
 * Emptied, not freed, on every init: the old patterns' code lives in the
 * replaced instance's memory, which went with it.
 */
class RegexCache {
  readonly #entries = new Map<string, Pcre2Regex>();
  readonly #limit: number;
  compiles = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  compiled(key: string, source: string, flags: string, limits: RegexLimits): Pcre2Regex {
    const hit = this.#entries.get(key);
    if (hit && !hit.freed) {
      // Re-inserted so the Map's order is least-recently-used first.
      this.#entries.delete(key);
      this.#entries.set(key, hit);
      return hit;
    }
    const regex = new Pcre2Regex(source, flags, limits);
    this.compiles++;
    if (this.#entries.size >= this.#limit) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) {
        this.#entries.get(oldest.value)?.free();
        this.#entries.delete(oldest.value);
      }
    }
    this.#entries.set(key, regex);
    return regex;
  }
}

const cache = new RegexCache(256);
/**
 * Diagnostic probes (the no-op explainer's truncated patterns) get their own
 * cache: through the shared one, a few hundred of them evicted the patterns the
 * pipeline was running, and every event then recompiled its whole config.
 */
const probeCache = new RegexCache(256);

/** How many compiled patterns wasm memory holds; for the cache-bound test. */
export function cachedRegexCount(): number {
  return cache.size;
}

/**
 * How many times either cache has compiled a pattern. A cost test counts
 * compiles rather than timing a run, which coverage instrumentation and a
 * loaded CI runner make meaningless.
 */
export function regexCompileCount(): number {
  return cache.compiles + probeCache.compiles;
}

/** How many compiled probes the separate probe cache holds; for tests. */
export function cachedProbeCount(): number {
  return probeCache.size;
}

/**
 * A pattern compiled with PCRE2. Stateless between calls (no `lastIndex`):
 * every search says where it starts.
 *
 * A match that hits MATCH_LIMIT or DEPTH_LIMIT is no match, as it is in
 * Splunk; `lastError` then says which limit, so a caller can report it.
 */
export class SplunkRegex {
  readonly source: string;
  readonly flags: string;
  readonly captureCount: number;
  /** Named groups in group order. */
  readonly names: readonly string[];
  /** Set when the last call stopped at a limit; cleared by every call. */
  lastError: string | undefined;

  readonly #key: string;
  readonly #limits: RegexLimits;
  readonly #cache: RegexCache;

  /** Throws when PCRE2 rejects the pattern; see {@link safeRegex}. */
  constructor(source: string, flags = '', limits: RegexLimits = {}, probe = false) {
    this.source = source;
    this.flags = flags;
    this.#limits = limits;
    this.#cache = probe ? probeCache : cache;
    this.#key = `${flags}\u0000${limits.matchLimit ?? ''}\u0000${limits.depthLimit ?? ''}\u0000${source}`;
    const regex = this.#cache.compiled(this.#key, source, flags, limits);
    this.captureCount = regex.captureCount;
    this.names = regex.names;
  }

  #regex(): Pcre2Regex {
    return this.#cache.compiled(this.#key, this.source, this.flags, this.#limits);
  }

  #limitHit(e: unknown): void {
    if (!(e instanceof RegexMatchError)) throw e;
    this.lastError = e.message;
  }

  /** The first match at or after `start`, or null. */
  exec(subject: string, start = 0): RegexMatch | null {
    this.lastError = undefined;
    try {
      return this.#regex().exec(subject, start);
    } catch (e) {
      this.#limitHit(e);
      return null;
    }
  }

  test(subject: string, start = 0): boolean {
    return this.exec(subject, start) !== null;
  }

  /**
   * Every match from `start`, as PCRE2 iterates (after an empty match the same
   * place is retried with an empty match forbidden, as in Perl). Collected
   * eagerly: the caller may compile other patterns between matches, which could
   * evict this one mid-iteration. A limit hit ends the list where it happened.
   */
  matchAll(subject: string, start = 0): RegexMatch[] {
    this.lastError = undefined;
    const matches: RegexMatch[] = [];
    try {
      for (const m of this.#regex().matchAll(subject, start)) matches.push(m);
    } catch (e) {
      this.#limitHit(e);
    }
    return matches;
  }

  /**
   * `subject` with the first match (or every match, when `global`) replaced by
   * what `replacer` returns for it. The template is the caller's to expand:
   * each Splunk directive has its own replacement syntax.
   */
  replace(subject: string, replacer: (match: RegexMatch) => string, global: boolean): string {
    const matches = global ? this.matchAll(subject) : [this.exec(subject)].filter((m) => m !== null);
    let out = '';
    let last = 0;
    for (const m of matches) {
      out += subject.slice(last, Math.max(m.index, last)) + replacer(m);
      last = Math.max(last, m.end);
    }
    return out + subject.slice(last);
  }
}

/**
 * Compile a pattern, or null when PCRE2 rejects it. `flags` are PCRE2 option
 * letters (`i`, `m`, `s`, `x`); inline settings like `(?i)` work too.
 */
export function safeRegex(pattern: string, flags = '', limits: RegexLimits = {}): SplunkRegex | null {
  return compileOrNull(pattern, flags, limits, false);
}

/**
 * {@link safeRegex} for a throwaway diagnostic pattern: compiled into a cache
 * of its own, so probing never evicts a pattern the pipeline is running.
 */
export function safeProbeRegex(pattern: string, limits: RegexLimits = {}): SplunkRegex | null {
  return compileOrNull(pattern, '', limits, true);
}

function compileOrNull(pattern: string, flags: string, limits: RegexLimits, probe: boolean): SplunkRegex | null {
  try {
    return new SplunkRegex(pattern, flags, limits, probe);
  } catch (e) {
    if (e instanceof RegexSyntaxError) return null;
    throw e;
  }
}

/**
 * Why PCRE2 rejects a pattern — its own message, with the offset — or null
 * when it compiles. Compiling never executes the pattern.
 */
export function validateRegex(pattern: string): string | null {
  return regexError(pattern)?.message ?? null;
}

/** {@link validateRegex} with the offset into the pattern, for editor markers. */
export function regexError(pattern: string): { message: string; offset: number } | null {
  try {
    new SplunkRegex(pattern);
    return null;
  } catch (e) {
    if (e instanceof RegexSyntaxError) return { message: e.message, offset: e.offset };
    throw e;
  }
}
