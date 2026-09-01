// arena_demo — prove sysheap confines generic + mbedtls allocation to the static
// arena, leaving the system heap flat. Exercises raw malloc (what lwIP/app use)
// and an mbedtls SSL context (TLS handshake buffers) after enabling the arena.

#include <Arduino.h>

#include "mbedtls/bignum.h"
#include "sysheap.h"

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("arena-demo: boot");

  uint32_t sys0 = esp_get_free_heap_size();
  sysheap_init();
  uint32_t sys1 = esp_get_free_heap_size();
  Serial.printf("arena-demo: init; sys_heap %u->%u arena=%u/%u\n", sys0, sys1,
                (unsigned)sysheap_arena_free(), (unsigned)sysheap_arena_size());

  // Generic malloc (what lwIP / the app use) — must come from the arena now.
  void *p[24];
  for (int i = 0; i < 24; i++) p[i] = malloc(256 + i * 64);

  // mbedtls bignum: read + multiply allocate dynamic limbs via calloc -> arena.
  mbedtls_mpi a, b, c;
  mbedtls_mpi_init(&a); mbedtls_mpi_init(&b); mbedtls_mpi_init(&c);
  mbedtls_mpi_read_string(&a, 16, "deadbeefcafebabe0123456789abcdef");
  mbedtls_mpi_read_string(&b, 16, "feedface8badf00d1122334455667788");
  int rc = mbedtls_mpi_mul_mpi(&c, &a, &b);

  uint32_t sys2 = esp_get_free_heap_size();
  Serial.printf("arena-demo: after mallocs + mbedtls cfg: sys_heap=%u (drift=%d) "
                "arena_used=%u\n",
                sys2, (int)((int)sys1 - (int)sys2),
                (unsigned)(sysheap_arena_size() - sysheap_arena_free()));

  for (int i = 0; i < 24; i++) free(p[i]);
  mbedtls_mpi_free(&a); mbedtls_mpi_free(&b); mbedtls_mpi_free(&c);
  Serial.println("arena-demo: cleanup done (mallocs + mbedtls freed)");
}

void loop() {
  static uint32_t t = 0, sys0 = 0;
  uint32_t sys = esp_get_free_heap_size();
  if (t == 0) sys0 = sys;
  Serial.printf("arena-demo: t=%lu sys_heap=%u (drift=%d) arena_free=%u\n", t, sys,
                (int)((int)sys - (int)sys0), (unsigned)sysheap_arena_free());
  t++;
  delay(1000);
}
