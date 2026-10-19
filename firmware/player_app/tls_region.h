// mbedTLS's own memory region (docs/design/memory-regions.md, "TLS slab"): every
// mbedtls_calloc/free lands here instead of the shared IDF heap, so a TLS handshake
// can't fail on a fragmented heap and its churn (93% of post-boot allocation bytes,
// heap census #271) can't fragment the heap for anyone else.
//   - record buffers (the dynamic in/out record buffers, up to ~6.8 KB each — the
//     contiguous blocks a fragmented heap couldn't supply) get fixed slots;
//   - everything else (handshake state, bignums, x509, transforms) a private TLSF
//     region.
// A request that doesn't fit falls back to the shared heap and is counted, so an
// undersized region degrades to today's behaviour instead of failing.
#pragma once

#include <stddef.h>
#include <stdint.h>

struct TlsRegionStats {
  uint32_t small_size;      // bytes in the small-block region
  uint32_t small_peak;      // its high-water (size - minimum free)
  uint32_t slot_size;       // bytes per record slot
  uint8_t slots;            // record slots
  uint8_t slots_peak;       // most slots in use at once
  uint32_t largest_request; // largest single mbedtls_calloc seen
  uint32_t fallbacks;       // requests served by the shared heap (region full / oversize)
  uint32_t fallback_live;   // bytes currently held on the shared heap via fallback
};

// Route mbedTLS's allocator here. Call before ANY mbedtls allocation (tls_init's first
// line): a block allocated before is freed through the fallback path correctly anyway.
void tls_region_install();

const TlsRegionStats &tls_region_stats();
