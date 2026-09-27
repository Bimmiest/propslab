/* PCRE2 build configuration for the WebAssembly module.
 *
 * The limits below are PCRE2's own defaults, written out so the build does not
 * change silently with a PCRE2 upgrade; the bridge applies per-call match and
 * depth limits on top of them. */

#define SUPPORT_UNICODE 1
#define PCRE2_STATIC 1
#define PCRE2_EXPORT
#define HAVE_MEMMOVE 1
#define HAVE_STDINT_H 1
#define HAVE_LIMITS_H 1

/* LF, PCRE2's default: `.` matches `\r`, and `$` matches before a final `\n`
 * only. A pattern can choose another convention with (*CRLF), (*ANY), etc. */
#define NEWLINE_DEFAULT 2
#define LINK_SIZE 2
#define MATCH_LIMIT 10000000
#define MATCH_LIMIT_DEPTH MATCH_LIMIT
#define HEAP_LIMIT 20000000
#define PARENS_NEST_LIMIT 250
#define MAX_NAME_SIZE 128
#define MAX_NAME_COUNT 10000
#define MAX_VARLOOKBEHIND 255
