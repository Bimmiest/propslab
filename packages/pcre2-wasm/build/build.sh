#!/usr/bin/env bash
# Builds pcre2.wasm from a pinned PCRE2 release.
#
#   build/build.sh           build, then write the module and its checksum
#   build/build.sh --check   build into a temp dir and fail unless the result
#                                 is byte-identical to the committed module
#
# Needs only clang with the wasm32 target and wasm-ld (LLVM's lld): no
# emscripten, no wasi-sdk. The module imports nothing and brings its own tiny
# libc (libc/), so there is no JS glue to generate. The build is reproducible
# for a given clang major version; CI rebuilds with the one named below and
# compares, so the committed binary is known to come from this source.
set -euo pipefail

PCRE2_VERSION=10.48
PCRE2_SHA256=ebcc25aadf2a51fa1fefa9b8bc9e7a79b3dae86870a0f1152a22e42befd46888
PCRE2_URL="https://github.com/PCRE2Project/pcre2/releases/download/pcre2-${PCRE2_VERSION}/pcre2-${PCRE2_VERSION}.tar.gz"
# The toolchain the committed module was built with. Another major version
# produces a working module but not the same bytes.
EXPECTED_CLANG_MAJOR=18

CLANG=${CLANG:-clang}
WASM_LD=${WASM_LD:-wasm-ld}

here=$(cd "$(dirname "$0")" && pwd)
pkg=$(cd "$here/.." && pwd)
out="$pkg/pcre2.wasm"
sumfile="$pkg/pcre2.wasm.sha256"

check=0
[[ "${1:-}" == "--check" ]] && check=1

clang_major=$("$CLANG" -dumpversion | cut -d. -f1)
if [[ "$clang_major" != "$EXPECTED_CLANG_MAJOR" ]]; then
  echo "warning: clang $clang_major, expected $EXPECTED_CLANG_MAJOR; output will not match the committed module" >&2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cache="${PCRE2_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pcre2-wasm}"
mkdir -p "$cache"
tarball="$cache/pcre2-${PCRE2_VERSION}.tar.gz"
if [[ ! -f "$tarball" ]] || ! echo "$PCRE2_SHA256  $tarball" | sha256sum -c --status; then
  curl -fsSL "$PCRE2_URL" -o "$tarball.part"
  mv "$tarball.part" "$tarball"
fi
echo "$PCRE2_SHA256  $tarball" | sha256sum -c --quiet

tar xzf "$tarball" -C "$work"
src="$work/pcre2-${PCRE2_VERSION}/src"
cp "$src/pcre2.h.generic" "$src/pcre2.h"
cp "$src/pcre2_chartables.c.dist" "$src/pcre2_chartables.c"

sources=(
  auto_possess chartables chkdint compile compile_cgroup compile_class config
  context error extuni find_bracket match match_data match_next newline ord2utf
  pattern_info script_run string_utils study substitute substring tables ucd valid_utf
  xclass
)

cflags=(
  --target=wasm32 -O2 -ffreestanding -nostdlib -mbulk-memory
  -fno-builtin-malloc -fno-builtin-free
  -ffile-prefix-map="$work"=. -ffile-prefix-map="$here"=.
  -DHAVE_CONFIG_H -DPCRE2_CODE_UNIT_WIDTH=16
  -I "$here" -isystem "$here/libc/include" -I "$src"
  -Wno-unused-command-line-argument
)

objs=()
for name in "${sources[@]}"; do
  "$CLANG" "${cflags[@]}" -c "$src/pcre2_${name}.c" -o "$work/${name}.o"
  objs+=("$work/${name}.o")
done
"$CLANG" "${cflags[@]}" -c "$here/libc/libc.c" -o "$work/libc.o"
"$CLANG" "${cflags[@]}" -c "$here/bridge.c" -o "$work/bridge.o"

# 1 MiB of stack, placed first so an overflow traps instead of running into
# static data; memory may grow to 1 GiB.
"$WASM_LD" --no-entry --gc-sections --strip-all --stack-first \
  -z stack-size=1048576 --max-memory=1073741824 \
  "${objs[@]}" "$work/libc.o" "$work/bridge.o" -o "$work/pcre2.wasm"

built_sum=$(sha256sum "$work/pcre2.wasm" | cut -d' ' -f1)

if [[ $check -eq 1 ]]; then
  committed_sum=$(sha256sum "$out" | cut -d' ' -f1)
  recorded_sum=$(cut -d' ' -f1 "$sumfile")
  if [[ "$committed_sum" != "$recorded_sum" ]]; then
    echo "pcre2.wasm does not match pcre2.wasm.sha256" >&2
    exit 1
  fi
  if [[ "$built_sum" != "$committed_sum" ]]; then
    echo "rebuilt module ($built_sum) differs from the committed one ($committed_sum)" >&2
    exit 1
  fi
  echo "pcre2.wasm reproduces: $built_sum"
else
  cp "$work/pcre2.wasm" "$out"
  echo "$built_sum  pcre2.wasm" > "$sumfile"
  echo "wrote $out ($(wc -c < "$out") bytes, sha256 $built_sum)"
fi
