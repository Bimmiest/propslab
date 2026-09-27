/* The C locale's classification, which is all PCRE2 relies on at run time:
 * its character tables are the prebuilt pcre2_chartables.c.dist. */
#ifndef PW_CTYPE_H
#define PW_CTYPE_H
static inline int isspace(int c) { return c == ' ' || (c >= '\t' && c <= '\r'); }
static inline int isdigit(int c) { return c >= '0' && c <= '9'; }
static inline int isupper(int c) { return c >= 'A' && c <= 'Z'; }
static inline int islower(int c) { return c >= 'a' && c <= 'z'; }
static inline int isalpha(int c) { return isupper(c) || islower(c); }
static inline int isalnum(int c) { return isalpha(c) || isdigit(c); }
static inline int isxdigit(int c) { return isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
static inline int tolower(int c) { return isupper(c) ? c + 32 : c; }
static inline int toupper(int c) { return islower(c) ? c - 32 : c; }
#endif
