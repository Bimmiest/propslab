# pcre2-wasm-utf16

[PCRE2](https://github.com/PCRE2Project/pcre2) compiled to WebAssembly, for
browsers, workers and Node.

- **The 16-bit library, in UTF mode.** A JS string's UTF-16 code units are
  handed to PCRE2 as they are, so every offset it reports — match start and
  end, every group span — is a JS string index. Nothing is transcoded to UTF-8
  and back.
- **Built here, from a pinned release.** `build/build.sh` downloads PCRE2
  10.48, checks its SHA-256, and compiles it with plain clang and `wasm-ld`. No
  emscripten, no generated JS glue: the module imports nothing and brings its
  own few libc functions (`build/libc/`). The build is byte-for-byte
  reproducible for a given clang major version, and `pcre2.wasm.sha256` records
  the result.
- **No JIT.** There is no JIT for WebAssembly; every match runs PCRE2's
  interpreter (`pcre2_match`). Match and depth limits therefore count what the
  interpreter counts, which is not what they count under JIT.
- **~300 KB** raw, **~80 KB** gzipped.

This package is not published yet; it lives in the propslab repository, which
consumes it from source.

## Loading

The package never fetches or reads a file itself. Give `init` the bytes or an
already compiled `WebAssembly.Module`:

```ts
import { init, initSync, getModule, Regex } from 'pcre2-wasm-utf16';

// Browser: compile once, streaming. Needs 'wasm-unsafe-eval' in a CSP script-src.
const wasmUrl = new URL('pcre2-wasm-utf16/pcre2.wasm', import.meta.url);
await init(WebAssembly.compileStreaming(fetch(wasmUrl)));

// Hand the compiled module to a worker instead of compiling it again there.
worker.postMessage({ pcre2: getModule() });
// …and in the worker (synchronous instantiation is fine off the main thread):
initSync(event.data.pcre2);

// Node:
import { readFileSync } from 'node:fs';
initSync(readFileSync(new URL('../pcre2.wasm', import.meta.url)));
```

## Use

```ts
const re = new Regex('(?<key>\\w+)=(?<value>\\S+)', 'i', { matchLimit: 100000 });

re.exec('a=1 b=2');                // first match, or null
re.exec('a=1 b=2', 4);             // first match at or after offset 4
re.test('a=1');                    // boolean
for (const m of re.matchAll('a=1 b=2')) {
  m[0];            // 'a=1'
  m.index, m.end;  // 0, 3
  m.groups?.key;   // 'a'
  m.indices[2];    // [2, 3]
}
re.substitute('a=1 b=2', '${value}=${key}', { global: true });  // '1=a 2=b'
re.replace('a=1 b=2', (m) => m[1]!.toUpperCase(), true);        // 'A B'

re.free();  // release the compiled pattern's wasm memory
```

A match is shaped like a `RegExpExecArray` with the `d` flag: element N is
group N's text, or `undefined` when it did not take part.

**Flags** are letters: `i` caseless, `m` multiline, `s` dotall, `x` extended,
`n` no auto-capture, `U` ungreedy, `J` duplicate names, `u` UCP (Unicode
`\w`, `\d`, `\b` and POSIX classes), `A` anchored, `D` dollar-end-only. Inline
settings — `(?i)`, `(*UCP)`, `(*CRLF)` and the rest — work as in PCRE2.

**Iteration** follows PCRE2's own rule (`pcre2_next_match`): after an empty
match, the next attempt is at the same place with an empty match there
forbidden, as in Perl. That differs from JS's `matchAll`, which steps forward one
code unit.

**Newlines** are LF, PCRE2's default: `.` matches `\r`, and `$` matches at the
end or before a final `\n`.

**Errors.** A pattern PCRE2 rejects throws `RegexSyntaxError`, with the
`offset` into the pattern. A match that hits a limit throws `RegexMatchError`
with PCRE2's error `code` (`ERROR_MATCHLIMIT`, `ERROR_DEPTHLIMIT`,
`ERROR_HEAPLIMIT`); backtracking memory is capped at 64 MiB per match.

**Lone surrogates** in a subject are matched as U+FFFD (one code unit, so
offsets are unaffected); the text returned is sliced from the original string.

## Memory

Compiled patterns live in wasm memory, which the garbage collector does not
see. Call `free()` when done with a `Regex`; one collected without it is freed
by a `FinalizationRegistry`, eventually. Using a freed `Regex` throws. The
subject buffer and match data are shared by every call and grow to the largest
used; wasm memory can grow to 1 GiB and never shrinks.

## Building

```sh
npm run build:wasm   # rebuild pcre2.wasm and pcre2.wasm.sha256
npm run check:wasm   # rebuild in a temp dir; fail unless identical to the committed file
npm test             # node:test, no dependencies
```

Needs clang 18 with the wasm32 target and `wasm-ld` (Debian/Ubuntu: `clang-18
lld-18`). Another clang major version builds a working module whose bytes differ.

## Licence

The wrapper, bridge and build script are MIT (`LICENSE`). `pcre2.wasm` contains
PCRE2, under its BSD licence with the PCRE2 exemption, reproduced in
`LICENCE-PCRE2.md`; see `NOTICE`.
