#pragma once
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
// Register the static arena, hook mbedtls, and enable malloc-wrapping. Call once,
// early, before the subsystems that should allocate from the arena.
void sysheap_init(void);
size_t sysheap_arena_free(void);
size_t sysheap_arena_size(void);
#ifdef __cplusplus
}
#endif
