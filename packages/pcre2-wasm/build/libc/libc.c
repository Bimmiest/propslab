/* The few libc functions PCRE2 needs, for a freestanding wasm32 build.
 *
 * Built with -mbulk-memory, so the memory primitives below compile to the
 * memory.copy / memory.fill instructions rather than loops. */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

void *memcpy(void *restrict dst, const void *restrict src, size_t n) {
  __builtin_memmove(dst, src, n);
  return dst;
}

void *memmove(void *dst, const void *src, size_t n) {
  __builtin_memmove(dst, src, n);
  return dst;
}

void *memset(void *dst, int c, size_t n) {
  __builtin_memset(dst, c, n);
  return dst;
}

int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = a, *y = b;
  for (size_t i = 0; i < n; i++) {
    if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

void *memchr(const void *s, int c, size_t n) {
  const unsigned char *p = s;
  for (size_t i = 0; i < n; i++) {
    if (p[i] == (unsigned char)c) return (void *)(p + i);
  }
  return NULL;
}

size_t strlen(const char *s) {
  size_t n = 0;
  while (s[n]) n++;
  return n;
}

int strcmp(const char *a, const char *b) {
  while (*a && *a == *b) a++, b++;
  return (unsigned char)*a - (unsigned char)*b;
}

char *strchr(const char *s, int c) {
  for (;; s++) {
    if (*s == (char)c) return (char *)s;
    if (!*s) return NULL;
  }
}

void abort(void) { __builtin_trap(); }

/* ---------------------------------------------------------------------------
 * Allocator: power-of-two size classes with a free list per class, carved from
 * the top of the heap. Freed blocks are reused by later requests of the same
 * class and never returned (wasm memory cannot shrink anyway). That fits how
 * the bridge uses memory: compiled patterns sit in a bounded LRU on the JS
 * side, and the match data and subject buffer are long-lived and grow to a
 * peak. Rounding to a power of two bounds the waste at half a block.
 * ------------------------------------------------------------------------- */

#define MIN_CLASS 4 /* 16 bytes */
#define NUM_CLASSES 32
#define HEADER 16 /* keeps payloads 16-byte aligned */
#define PAGE 65536

extern unsigned char __heap_base;

static uintptr_t heap_top;
static uintptr_t heap_end;
static void *free_lists[NUM_CLASSES];

static int class_for(size_t size) {
  int c = MIN_CLASS;
  while (c < NUM_CLASSES && ((size_t)1 << c) < size) c++;
  return c;
}

static int grow_to(uintptr_t needed) {
  if (needed <= heap_end) return 1;
  size_t pages = (needed - heap_end + PAGE - 1) / PAGE;
  if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
  heap_end += pages * PAGE;
  return 1;
}

void *malloc(size_t size) {
  if (size > ((size_t)1 << (NUM_CLASSES - 1)) - HEADER) return NULL;
  int c = class_for(size + HEADER);
  unsigned char *block = free_lists[c];
  if (block) {
    free_lists[c] = *(void **)(block + HEADER);
  } else {
    if (!heap_top) {
      heap_top = ((uintptr_t)&__heap_base + HEADER - 1) & ~(uintptr_t)(HEADER - 1);
      heap_end = __builtin_wasm_memory_size(0) * PAGE;
    }
    size_t bytes = (size_t)1 << c;
    if (heap_top + bytes < heap_top || !grow_to(heap_top + bytes)) return NULL;
    block = (unsigned char *)heap_top;
    heap_top += bytes;
  }
  *(int *)block = c;
  return block + HEADER;
}

void free(void *ptr) {
  if (!ptr) return;
  unsigned char *block = (unsigned char *)ptr - HEADER;
  int c = *(int *)block;
  *(void **)ptr = free_lists[c];
  free_lists[c] = block;
}
