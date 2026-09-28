/**
 * PCRE2 compiled to WebAssembly: the 16-bit library in UTF mode, so a JS
 * string's UTF-16 code units are the subject as they are and every offset is
 * a JS string index.
 *
 * Loading is the caller's: this module never fetches or reads a file, so it
 * runs unchanged in a browser, a worker and Node. Call {@link init} (or
 * {@link initSync}) once with the module's bytes or an already compiled
 * `WebAssembly.Module`; everything after that is synchronous.
 *
 * Compiled patterns live in wasm memory, which no garbage collector sees.
 * Call {@link Regex.free} when done with one; a finalizer frees any that are
 * collected without it, but only eventually.
 */

// ---------------------------------------------------------------------------
// WebAssembly, typed locally so the module type-checks against the ES
// libraries alone (no DOM, no Node types).
// ---------------------------------------------------------------------------

/** A compiled `WebAssembly.Module`. */
export type CompiledModule = object;
/** The module's bytes. */
export type ModuleBytes = ArrayBuffer | ArrayBufferView;

interface WasmApi {
  Module: new (bytes: ModuleBytes) => CompiledModule;
  Instance: new (module: CompiledModule, imports: object) => { exports: unknown };
  compile(bytes: ModuleBytes): Promise<CompiledModule>;
  instantiate(module: CompiledModule, imports: object): Promise<{ exports: unknown }>;
}

interface Exports {
  memory: { buffer: ArrayBuffer };
  pw_state(): number;
  pw_alloc(bytes: number): number;
  pw_free(ptr: number): void;
  pw_compile(pattern: number, length: number, options: number, extraOptions: number): number;
  pw_code_free(code: number): void;
  pw_capture_count(code: number): number;
  pw_name_count(code: number): number;
  pw_name_entry_size(code: number): number;
  pw_name_table(code: number): number;
  pw_error_message(code: number, buffer: number, length: number): number;
  pw_match(
    code: number,
    subject: number,
    length: number,
    start: number,
    options: number,
    matchLimit: number,
    depthLimit: number,
  ): number;
  pw_ovector(): number;
  pw_next_match(): number;
  pw_substitute(
    code: number,
    subject: number,
    length: number,
    start: number,
    options: number,
    replacement: number,
    replacementLength: number,
    output: number,
    capacity: number,
    matchLimit: number,
    depthLimit: number,
  ): number;
  pw_version(buffer: number): number;
}

const WA = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;

let wasm: Exports | null = null;
let compiledModule: CompiledModule | null = null;
/** Bumped on every init, so a Regex from an earlier instance is never run
 * (or freed) against a later one's memory. */
let generation = 0;

function isBytes(source: unknown): source is ModuleBytes {
  return source instanceof ArrayBuffer || ArrayBuffer.isView(source);
}

function adopt(module: CompiledModule, exports: unknown): void {
  compiledModule = module;
  wasm = exports as Exports;
  generation++;
  subjectText = null;
  subjectPtr = 0;
  subjectCapacity = 0;
}

/**
 * Instantiate from a compiled module or the module's bytes, synchronously.
 * For workers and Node; a browser's main thread must use {@link init}, since
 * it refuses synchronous compilation of anything but a tiny module.
 */
export function initSync(source: CompiledModule | ModuleBytes): void {
  const module = isBytes(source) ? new WA.Module(source) : source;
  adopt(module, new WA.Instance(module, {}).exports);
}

/** Instantiate from a compiled module, the module's bytes, or a promise of either. */
export async function init(
  source: CompiledModule | ModuleBytes | PromiseLike<CompiledModule | ModuleBytes>,
): Promise<void> {
  const resolved = await source;
  const module = isBytes(resolved) ? await WA.compile(resolved) : resolved;
  adopt(module, (await WA.instantiate(module, {})).exports);
}

export function isReady(): boolean {
  return wasm !== null;
}

/**
 * The compiled module in use, for handing to a worker (`WebAssembly.Module`
 * structured-clones), so it is compiled once rather than once per thread.
 */
export function getModule(): CompiledModule {
  if (!compiledModule) throw notReady();
  return compiledModule;
}

function notReady(): Error {
  return new Error('pcre2-wasm is not initialised: call init() first.');
}

function engine(): Exports {
  if (!wasm) throw notReady();
  return wasm;
}

// ---------------------------------------------------------------------------
// Constants (pcre2.h)
// ---------------------------------------------------------------------------

const PCRE2_ANCHORED = 0x80000000;
const PCRE2_CASELESS = 0x00000008;
const PCRE2_DOLLAR_ENDONLY = 0x00000010;
const PCRE2_DOTALL = 0x00000020;
const PCRE2_DUPNAMES = 0x00000040;
const PCRE2_EXTENDED = 0x00000080;
const PCRE2_MULTILINE = 0x00000400;
const PCRE2_NO_AUTO_CAPTURE = 0x00002000;
const PCRE2_UCP = 0x00020000;
const PCRE2_UNGREEDY = 0x00040000;
const PCRE2_UTF = 0x00080000;
/**
 * Every subject is valid UTF-16 by the time it reaches wasm memory (see
 * loadSubject), so PCRE2 is told not to re-validate it. The check it would
 * otherwise make covers the rest of the subject on every call, which turns a
 * global iteration quadratic.
 */
const PCRE2_NO_UTF_CHECK = 0x40000000;
const PCRE2_ERROR_NOMATCH = -1;
const PCRE2_ERROR_NOMEMORY = -48;
const PCRE2_SUBSTITUTE_GLOBAL = 0x00000100;
const PCRE2_SUBSTITUTE_EXTENDED = 0x00000200;
const PCRE2_SUBSTITUTE_UNSET_EMPTY = 0x00000400;
const PCRE2_SUBSTITUTE_OVERFLOW_LENGTH = 0x00001000;
const PCRE2_UNSET = 0xffffffff;
/** Errors pcre2_substitute reports for a malformed replacement string. */
const REPLACEMENT_ERRORS = new Set([-35, -49, -57, -58, -59, -60, -69]);

/**
 * Compile flags, as letters. UTF mode is always on.
 *
 * | letter | PCRE2 option | inline equivalent |
 * |---|---|---|
 * | `i` | CASELESS | `(?i)` |
 * | `m` | MULTILINE | `(?m)` |
 * | `s` | DOTALL | `(?s)` |
 * | `x` | EXTENDED | `(?x)` |
 * | `n` | NO_AUTO_CAPTURE | `(?n)` |
 * | `U` | UNGREEDY | `(?U)` |
 * | `J` | DUPNAMES | `(?J)` |
 * | `u` | UCP (Unicode `\w`, `\d`, `\b`, POSIX classes) | `(*UCP)` |
 * | `A` | ANCHORED | — |
 * | `D` | DOLLAR_ENDONLY | — |
 */
const FLAG_OPTIONS: Readonly<Record<string, number>> = {
  i: PCRE2_CASELESS,
  m: PCRE2_MULTILINE,
  s: PCRE2_DOTALL,
  x: PCRE2_EXTENDED,
  n: PCRE2_NO_AUTO_CAPTURE,
  U: PCRE2_UNGREEDY,
  J: PCRE2_DUPNAMES,
  u: PCRE2_UCP,
  A: PCRE2_ANCHORED,
  D: PCRE2_DOLLAR_ENDONLY,
};

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

/** The subject currently in wasm memory, so repeated matching against one
 * string (a global iteration, several patterns over one text) copies it once. */
let subjectText: string | null = null;
let subjectPtr = 0;
let subjectCapacity = 0; // in code units

function readUtf16(ptr: number, length: number): string {
  const view = new Uint16Array(engine().memory.buffer, ptr, length);
  let out = '';
  for (let i = 0; i < length; i += 8192) {
    out += String.fromCharCode(...view.subarray(i, Math.min(length, i + 8192)));
  }
  return out;
}

function alloc(bytes: number): number {
  const ptr = engine().pw_alloc(Math.max(bytes, 2));
  if (!ptr) throw new RegexMatchError(errorMessage(PCRE2_ERROR_NOMEMORY), PCRE2_ERROR_NOMEMORY);
  return ptr;
}

/** Copies `text` into wasm memory as UTF-16; the caller frees the result. */
function allocString(text: string): number {
  const ptr = alloc(text.length * 2);
  writeString(ptr, text);
  return ptr;
}

/**
 * Copies a string into wasm memory as valid UTF-16. A lone surrogate — legal
 * in a JS string, illegal in UTF-16 — is written as U+FFFD, which is also one
 * code unit, so every offset still lines up with the JS string, and match
 * text is sliced from the original.
 */
function writeString(ptr: number, text: string): void {
  const view = new Uint16Array(engine().memory.buffer, ptr, text.length);
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) {
      view[i] = c;
    } else if (c <= 0xdbff && i + 1 < n && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      view[i] = c;
      view[i + 1] = text.charCodeAt(i + 1);
      i++;
    } else {
      view[i] = 0xfffd;
    }
  }
}

/** `offset`, moved off the second half of a surrogate pair. */
function codePointBoundary(text: string, offset: number): number {
  if (offset > 0 && offset < text.length) {
    const c = text.charCodeAt(offset);
    const prev = text.charCodeAt(offset - 1);
    if ((c & 0xfc00) === 0xdc00 && (prev & 0xfc00) === 0xd800) return offset + 1;
  }
  return offset;
}

function loadSubject(text: string): number {
  if (text === subjectText) return subjectPtr;
  const w = engine();
  if (text.length > subjectCapacity) {
    if (subjectPtr) w.pw_free(subjectPtr);
    subjectPtr = 0;
    subjectCapacity = 0;
    subjectText = null;
    const capacity = Math.max(text.length, 1024);
    subjectPtr = alloc(capacity * 2);
    subjectCapacity = capacity;
  }
  writeString(subjectPtr, text);
  subjectText = text;
  return subjectPtr;
}

function stateView(): Uint32Array {
  const w = engine();
  return new Uint32Array(w.memory.buffer, w.pw_state(), 5);
}

function errorMessage(code: number): string {
  const w = engine();
  const units = 256;
  const buffer = w.pw_alloc(units * 2);
  if (!buffer) return `PCRE2 error ${code}`;
  try {
    const length = w.pw_error_message(code, buffer, units);
    return length < 0 ? `PCRE2 error ${code}` : readUtf16(buffer, length);
  } finally {
    w.pw_free(buffer);
  }
}

/** The PCRE2 release the module was built from, e.g. `10.48 2026-...`. */
export function version(): string {
  const w = engine();
  const buffer = alloc(128);
  try {
    // pcre2_config counts the terminating zero.
    return readUtf16(buffer, Math.max(0, w.pw_version(buffer) - 1));
  } finally {
    w.pw_free(buffer);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** PCRE2 rejected a pattern. */
export class RegexSyntaxError extends Error {
  /** Where in the pattern PCRE2 gave up, in UTF-16 code units. */
  readonly offset: number;
  /** PCRE2's error code. */
  readonly code: number;
  constructor(message: string, offset: number, code: number) {
    super(message);
    this.name = 'RegexSyntaxError';
    this.offset = offset;
    this.code = code;
  }
}

/** A match stopped without a verdict: a limit was hit, or memory ran out. */
export class RegexMatchError extends Error {
  /** PCRE2's error code, e.g. -47 for the match limit. */
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'RegexMatchError';
    this.code = code;
  }
}

/** PCRE2's error codes for the three resource limits. */
export const ERROR_MATCHLIMIT = -47;
export const ERROR_DEPTHLIMIT = -53;
export const ERROR_HEAPLIMIT = -63;

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

export interface RegexOptions {
  /**
   * pcre2_set_match_limit: how many times the matcher may call its internal
   * match() for one pcre2_match. Defaults to PCRE2's ten million.
   */
  matchLimit?: number;
  /**
   * pcre2_set_depth_limit: how deep backtracking may nest. Defaults to PCRE2's
   * ten million, which in practice leaves the 64 MiB heap limit in charge.
   */
  depthLimit?: number;
}

/** Group spans, `[start, end)` in UTF-16 code units, by group number. */
export interface MatchIndices extends Array<[number, number] | undefined> {
  groups: Record<string, [number, number] | undefined> | undefined;
}

/**
 * One match, shaped like a `RegExpExecArray` with the `d` flag: element N is
 * group N's text (undefined when it did not participate), with `index`,
 * `groups` and `indices` alongside.
 */
export interface Match extends Array<string | undefined> {
  0: string;
  /** Where the match starts. `\K` can move it away from where matching began. */
  index: number;
  /** Where the match ends. */
  end: number;
  input: string;
  groups: Record<string, string | undefined> | undefined;
  indices: MatchIndices;
}

export interface SubstituteOptions {
  /** Replace every match rather than the first. */
  global?: boolean;
  /**
   * PCRE2_SUBSTITUTE_EXTENDED: `\n`, `\u`, `\U`, `\l`, `\L`, `\E` and
   * `${n:+set:unset}` forms in the replacement.
   */
  extended?: boolean;
  /** Where to start looking. */
  start?: number;
}

function limitValue(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 0;
  // 0 tells the bridge "PCRE2's default", so a caller's 0 becomes 1.
  return Math.min(Math.max(1, Math.floor(limit)), 0xffffffff);
}

const finalizer = new FinalizationRegistry<{ code: number; generation: number }>((held) => {
  if (wasm && held.generation === generation) wasm.pw_code_free(held.code);
});

export class Regex {
  readonly source: string;
  readonly flags: string;
  readonly captureCount: number;
  /** Names by group number; undefined for an unnamed group (and group 0). */
  readonly groupNames: readonly (string | undefined)[];
  /** Named groups in group order; a name repeated under `(?J)` appears once. */
  readonly names: readonly string[];

  #code: number;
  readonly #generation: number;
  readonly #matchLimit: number;
  readonly #depthLimit: number;

  /** Throws {@link RegexSyntaxError} when PCRE2 rejects the pattern. */
  constructor(source: string, flags = '', options: RegexOptions = {}) {
    let bits = PCRE2_UTF;
    for (const f of flags) {
      const bit = FLAG_OPTIONS[f];
      if (bit === undefined) throw new Error(`Unknown flag "${f}"`);
      bits |= bit;
    }
    const w = engine();
    const ptr = allocString(source);
    let code: number;
    try {
      code = w.pw_compile(ptr, source.length, bits >>> 0, 0);
    } finally {
      w.pw_free(ptr);
    }
    if (!code) {
      const state = new Int32Array(w.memory.buffer, w.pw_state(), 2);
      const errorCode = state[0]!;
      const offset = state[1]!;
      throw new RegexSyntaxError(`${errorMessage(errorCode)} at offset ${offset}`, offset, errorCode);
    }

    this.source = source;
    this.flags = flags;
    this.#code = code;
    this.#generation = generation;
    this.#matchLimit = limitValue(options.matchLimit);
    this.#depthLimit = limitValue(options.depthLimit);

    this.captureCount = w.pw_capture_count(code);
    const groupNames = new Array<string | undefined>(this.captureCount + 1).fill(undefined);
    const nameCount = w.pw_name_count(code);
    if (nameCount > 0) {
      const entrySize = w.pw_name_entry_size(code);
      const units = new Uint16Array(w.memory.buffer, w.pw_name_table(code), nameCount * entrySize);
      for (let n = 0; n < nameCount; n++) {
        const base = n * entrySize;
        let end = base + 1;
        while (end < base + entrySize && units[end] !== 0) end++;
        groupNames[units[base]!] = String.fromCharCode(...units.subarray(base + 1, end));
      }
    }
    this.groupNames = groupNames;
    this.names = [...new Set(groupNames.filter((n): n is string => n !== undefined))];
    finalizer.register(this, { code, generation }, this);
  }

  /** Release the compiled pattern. Any later use throws. Idempotent. */
  free(): void {
    if (!this.#code) return;
    finalizer.unregister(this);
    if (wasm && this.#generation === generation) wasm.pw_code_free(this.#code);
    this.#code = 0;
  }

  get freed(): boolean {
    return this.#code === 0;
  }

  #live(): number {
    if (!this.#code) throw new Error('This Regex has been freed.');
    if (this.#generation !== generation) throw new Error('This Regex belongs to an earlier init().');
    return this.#code;
  }

  /** One pcre2_match: the match, or null for no match; throws on a limit. */
  #run(subject: string, start: number, options: number): Match | null {
    const code = this.#live();
    const w = engine();
    const ptr = loadSubject(subject);
    const rc = w.pw_match(
      code,
      ptr,
      subject.length,
      start,
      (options | PCRE2_NO_UTF_CHECK) >>> 0,
      this.#matchLimit,
      this.#depthLimit,
    );
    if (rc === PCRE2_ERROR_NOMATCH) return null;
    if (rc < 0) throw new RegexMatchError(errorMessage(rc), rc);
    return this.#readMatch(subject);
  }

  #readMatch(subject: string): Match {
    const w = engine();
    const count = this.captureCount + 1;
    const ov = new Uint32Array(w.memory.buffer, w.pw_ovector(), count * 2);
    const match = new Array<string | undefined>(count) as Match;
    const indices = new Array<[number, number] | undefined>(count) as MatchIndices;
    for (let g = 0; g < count; g++) {
      const s = ov[2 * g]!;
      const e = ov[2 * g + 1]!;
      if (s === PCRE2_UNSET) {
        match[g] = undefined;
        indices[g] = undefined;
      } else {
        // `\K` in a lookahead can put the start after the end; the text is
        // then empty, as PCRE2's own substring functions have it.
        match[g] = s <= e ? subject.slice(s, e) : '';
        indices[g] = [s, e];
      }
    }
    match.index = ov[0]!;
    match.end = ov[1]!;
    match.input = subject;
    if (this.names.length > 0) {
      // Null-prototype, as a RegExp's groups object is, so a group named
      // `__proto__` or `toString` is an ordinary key.
      const groups = Object.create(null) as Record<string, string | undefined>;
      const spans = Object.create(null) as Record<string, [number, number] | undefined>;
      for (const name of this.names) {
        groups[name] = undefined;
        spans[name] = undefined;
      }
      this.groupNames.forEach((name, g) => {
        // Under (?J) the first set group of a name wins, as in PCRE2's own
        // by-name lookup.
        if (name === undefined || groups[name] !== undefined) return;
        groups[name] = match[g];
        spans[name] = indices[g];
      });
      match.groups = groups;
      indices.groups = spans;
    } else {
      match.groups = undefined;
      indices.groups = undefined;
    }
    match.indices = indices;
    return match;
  }

  /**
   * The first match at or after `start`, or null. Throws
   * {@link RegexMatchError} when a limit stops the match.
   */
  exec(subject: string, start = 0): Match | null {
    if (start < 0 || start > subject.length) return null;
    return this.#run(subject, codePointBoundary(subject, start), 0);
  }

  test(subject: string, start = 0): boolean {
    return this.exec(subject, start) !== null;
  }

  /**
   * Every match from `start`, in order, advancing as PCRE2 prescribes
   * (pcre2_next_match): after an empty match the next attempt is at the same
   * place with an empty match there forbidden, as Perl does. Throws
   * {@link RegexMatchError} when a limit stops a match.
   */
  *matchAll(subject: string, start = 0): Generator<Match, void, undefined> {
    if (start < 0 || start > subject.length) return;
    let offset = codePointBoundary(subject, start);
    let options = 0;
    for (;;) {
      const match = this.#run(subject, offset, options);
      if (!match) return;
      // Read before yielding: the caller may run other patterns in between,
      // and they share the match data.
      const more = engine().pw_next_match() === 1;
      if (more) {
        const state = stateView();
        offset = state[2]!;
        options = state[3]!;
      }
      yield match;
      if (!more) return;
    }
  }

  /**
   * pcre2_substitute: `$n`, `${n}`, `${name}` and `$$` in `replacement`; an
   * unset group substitutes as empty.
   */
  substitute(subject: string, replacement: string, options: SubstituteOptions = {}): string {
    const code = this.#live();
    const start = codePointBoundary(subject, options.start ?? 0);
    if (start < 0 || start > subject.length) return subject;
    const w = engine();
    let bits = PCRE2_SUBSTITUTE_OVERFLOW_LENGTH | PCRE2_SUBSTITUTE_UNSET_EMPTY | PCRE2_NO_UTF_CHECK;
    if (options.global) bits |= PCRE2_SUBSTITUTE_GLOBAL;
    if (options.extended) bits |= PCRE2_SUBSTITUTE_EXTENDED;
    const replacementPtr = allocString(replacement);
    try {
      let capacity = subject.length + replacement.length + 64;
      for (;;) {
        const output = alloc(capacity * 2);
        try {
          const subjectPtr = loadSubject(subject);
          const rc = w.pw_substitute(
            code,
            subjectPtr,
            subject.length,
            start,
            bits >>> 0,
            replacementPtr,
            replacement.length,
            output,
            capacity,
            this.#matchLimit,
            this.#depthLimit,
          );
          const needed = stateView()[4]!;
          if (rc === PCRE2_ERROR_NOMEMORY && needed > capacity) {
            capacity = needed;
            continue;
          }
          if (rc < 0) {
            const message = errorMessage(rc);
            // Replacement-syntax errors are the caller's mistake, not a limit.
            if (REPLACEMENT_ERRORS.has(rc)) throw new RegexSyntaxError(message, 0, rc);
            throw new RegexMatchError(message, rc);
          }
          return readUtf16(output, needed);
        } finally {
          w.pw_free(output);
        }
      }
    } finally {
      w.pw_free(replacementPtr);
    }
  }

  /**
   * `subject` with the first match (or every match, when `global`) replaced by
   * what `replacer` returns for it. For replacement rules pcre2_substitute
   * does not speak.
   */
  replace(subject: string, replacer: (match: Match) => string, global = false): string {
    let out = '';
    let last = 0;
    const matches = global ? this.matchAll(subject) : [this.exec(subject)].filter((m) => m !== null);
    for (const m of matches) {
      const from = Math.max(m.index, last);
      out += subject.slice(last, from) + replacer(m);
      last = Math.max(last, m.end);
    }
    return out + subject.slice(last);
  }
}
