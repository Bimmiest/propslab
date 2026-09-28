/* The functions the module exports: a thin layer over PCRE2's API that keeps
 * every argument and result a plain number, so the JS side needs no glue.
 *
 * The 16-bit library, so a JS string's UTF-16 code units are the subject as
 * they are: offsets PCRE2 reports are JS string indices, with nothing to
 * transcode in either direction.
 *
 * One match data and one match context serve every call. The JS side reads the
 * ovector straight after each match, before anything else can run, so nothing
 * is lost by sharing them, and the heap frames the match data keeps stay warm
 * across calls instead of being reallocated per match. */

#define PCRE2_CODE_UNIT_WIDTH 16
#include "pcre2.h"

#include <stdlib.h>

#define EXPORT(name) __attribute__((export_name(#name)))

/* Heap for backtracking frames, in KiB. Bounds a runaway match's memory the
 * way the match limit bounds its time, well below the module's memory ceiling. */
#define HEAP_LIMIT_KIB (64 * 1024)

/* PCRE2's build defaults (config.h), used when the caller passes 0. */
#define DEFAULT_LIMIT 10000000

/* Results the JS side reads by address, so a call can return more than one
 * number without an out-parameter allocation. */
static struct {
  int32_t error_code;
  uint32_t error_offset;
  uint32_t next_start;
  uint32_t next_options;
  uint32_t output_length;
} state;

static pcre2_compile_context *ccontext;
static pcre2_match_context *mcontext;
static pcre2_match_data *mdata;
static uint32_t mdata_pairs;

EXPORT(pw_state) void *pw_state(void) { return &state; }

EXPORT(pw_alloc) void *pw_alloc(size_t bytes) { return malloc(bytes); }

EXPORT(pw_free) void pw_free(void *ptr) { free(ptr); }

EXPORT(pw_compile)
pcre2_code *pw_compile(PCRE2_SPTR pattern, size_t length, uint32_t options,
                       uint32_t extra_options) {
  if (!ccontext) ccontext = pcre2_compile_context_create(NULL);
  if (!ccontext) return NULL;
  pcre2_set_compile_extra_options(ccontext, extra_options);
  int error;
  PCRE2_SIZE offset;
  pcre2_code *code = pcre2_compile(pattern, length, options, &error, &offset, ccontext);
  if (!code) {
    state.error_code = error;
    state.error_offset = (uint32_t)offset;
  }
  return code;
}

EXPORT(pw_code_free) void pw_code_free(pcre2_code *code) { pcre2_code_free(code); }

static uint32_t info(const pcre2_code *code, uint32_t what) {
  uint32_t value = 0;
  pcre2_pattern_info(code, what, &value);
  return value;
}

EXPORT(pw_capture_count) uint32_t pw_capture_count(const pcre2_code *code) {
  return info(code, PCRE2_INFO_CAPTURECOUNT);
}

EXPORT(pw_name_count) uint32_t pw_name_count(const pcre2_code *code) {
  return info(code, PCRE2_INFO_NAMECOUNT);
}

/* In code units: the group number, then the zero-terminated name. */
EXPORT(pw_name_entry_size) uint32_t pw_name_entry_size(const pcre2_code *code) {
  return info(code, PCRE2_INFO_NAMEENTRYSIZE);
}

EXPORT(pw_name_table) PCRE2_SPTR pw_name_table(const pcre2_code *code) {
  PCRE2_SPTR table = NULL;
  pcre2_pattern_info(code, PCRE2_INFO_NAMETABLE, &table);
  return table;
}

/* Writes the message for `code` into `buffer` (UTF-16, zero-terminated);
 * returns its length, or a negative error. */
EXPORT(pw_error_message)
int pw_error_message(int code, PCRE2_UCHAR *buffer, size_t length) {
  return pcre2_get_error_message(code, buffer, length);
}

/* Readies the shared match data and context for `code`. */
static int prepare(const pcre2_code *code, uint32_t match_limit, uint32_t depth_limit) {
  if (!mcontext) {
    mcontext = pcre2_match_context_create(NULL);
    if (!mcontext) return PCRE2_ERROR_NOMEMORY;
    pcre2_set_heap_limit(mcontext, HEAP_LIMIT_KIB);
  }
  uint32_t pairs = pw_capture_count(code) + 1;
  if (!mdata || mdata_pairs < pairs) {
    if (mdata) pcre2_match_data_free(mdata);
    /* Rounded up so a run of patterns with slowly growing group counts does
     * not reallocate on each one. */
    uint32_t want = pairs < 16 ? 16 : pairs;
    mdata = pcre2_match_data_create(want, NULL);
    mdata_pairs = mdata ? want : 0;
    if (!mdata) return PCRE2_ERROR_NOMEMORY;
  }
  pcre2_set_match_limit(mcontext, match_limit ? match_limit : DEFAULT_LIMIT);
  pcre2_set_depth_limit(mcontext, depth_limit ? depth_limit : DEFAULT_LIMIT);
  return 0;
}

/* Returns pcre2_match's result; the ovector is at pw_ovector() afterwards.
 * A limit of 0 keeps the library default. */
EXPORT(pw_match)
int pw_match(const pcre2_code *code, PCRE2_SPTR subject, size_t length, size_t start,
             uint32_t options, uint32_t match_limit, uint32_t depth_limit) {
  int rc = prepare(code, match_limit, depth_limit);
  if (rc < 0) return rc;
  return pcre2_match(code, subject, length, start, options, mdata, mcontext);
}

EXPORT(pw_ovector) PCRE2_SIZE *pw_ovector(void) { return pcre2_get_ovector_pointer(mdata); }

/* PCRE2's own rule for where the next match of a global iteration starts, and
 * with which options (PCRE2_NOTEMPTY_ATSTART after an empty match). Returns 0
 * when the iteration is over; otherwise the state holds the next call's
 * start offset and options. */
EXPORT(pw_next_match) int pw_next_match(void) {
  PCRE2_SIZE start;
  uint32_t options;
  if (!pcre2_next_match(mdata, &start, &options)) return 0;
  state.next_start = (uint32_t)start;
  state.next_options = options;
  return 1;
}

/* pcre2_substitute into `output` (capacity in code units). Returns the number
 * of substitutions or a negative error; on PCRE2_ERROR_NOMEMORY with
 * PCRE2_SUBSTITUTE_OVERFLOW_LENGTH set, the state's output_length is the
 * capacity needed. */
EXPORT(pw_substitute)
int pw_substitute(const pcre2_code *code, PCRE2_SPTR subject, size_t length, size_t start,
                  uint32_t options, PCRE2_SPTR replacement, size_t replacement_length,
                  PCRE2_UCHAR *output, size_t capacity, uint32_t match_limit,
                  uint32_t depth_limit) {
  int rc = prepare(code, match_limit, depth_limit);
  if (rc < 0) return rc;
  PCRE2_SIZE out_length = capacity;
  rc = pcre2_substitute(code, subject, length, start, options, mdata, mcontext, replacement,
                        replacement_length, output, &out_length);
  state.output_length = (uint32_t)out_length;
  return rc;
}

/* The library's version string, e.g. "10.48 2026-...", as UTF-16. */
EXPORT(pw_version) int pw_version(PCRE2_UCHAR *buffer) {
  return pcre2_config(PCRE2_CONFIG_VERSION, buffer);
}
