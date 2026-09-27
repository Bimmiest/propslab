/* Minimal freestanding libc for the PCRE2 WebAssembly build: only what PCRE2
 * references. Implemented in ../libc.c. */
#ifndef PW_STDLIB_H
#define PW_STDLIB_H
#include <stddef.h>
void *malloc(size_t size);
void free(void *ptr);
void abort(void) __attribute__((noreturn));
#endif
