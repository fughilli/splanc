/* Host unit tests for the rfctl core: encoding, value parsing, the protocol, the
 * timeline scheduler (staging lead, same-instant grouping, lateness), the lease
 * watchdog, the safe state and the frame-start buffer. A mock HAL records every
 * shift and commit. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pi/hitl/meshbench/rfctl/rfctl_core.h"

static int g_fail;
#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
      g_fail++;                                                         \
    }                                                                   \
  } while (0)

static uint64_t g_now;
static char g_out[1 << 16];
static size_t g_out_len;
static int g_shifts, g_commits, g_armed;
static uint64_t g_armed_t;
static uint8_t g_shift[RFCTL_CHAIN_BITS / 8], g_latched[RFCTL_CHAIN_BITS / 8];
static int g_serial_writes;

uint64_t rfctl_hal_now_us(void) { return g_now; }
void rfctl_hal_chain_shift(const uint8_t *b, uint16_t n) {
  memcpy(g_shift, b, n / 8);
  g_shifts++;
}
static void commit(rfctl *c, uint64_t t) {
  memcpy(g_latched, g_shift, sizeof g_latched);
  rfctl_serial_words(c, false);
  g_commits++;
  rfctl_committed(c, t);
}
void rfctl_hal_arm_commit(struct rfctl *c, uint64_t t) {
  (void)c;
  g_armed = 1;
  g_armed_t = t;
}
void rfctl_hal_commit_now(struct rfctl *c) { commit(c, g_now); }
void rfctl_hal_serial_atten(uint8_t a, uint8_t b, uint8_t c, uint8_t w) {
  (void)a, (void)b, (void)c, (void)w;
  g_serial_writes++;
}
bool rfctl_hal_chain_loopback(const uint8_t *o, uint8_t *in, uint16_t n) {
  memcpy(in, o, n / 8);
  return true;
}
void rfctl_hal_cap_config(uint32_t m, uint32_t h) { (void)m, (void)h; }
void rfctl_hal_bootsel(void) {}
void rfctl_hal_reset(void) {}

static void wr(void *ctx, const char *s, size_t n) {
  (void)ctx;
  if (g_out_len + n < sizeof g_out) {
    memcpy(g_out + g_out_len, s, n);
    g_out_len += n;
    g_out[g_out_len] = 0;
  }
}
static rfctl C;
static const char *run(const char *line) {
  g_out_len = 0;
  g_out[0] = 0;
  rfctl_exec(&C, line);
  return g_out;
}
static int has(const char *hay, const char *needle) { return strstr(hay, needle) != NULL; }
static int bit(const uint8_t *chain, unsigned b) { return (chain[b >> 3] >> (b & 7)) & 1; }

/* run the scheduler like the platform: poll, commit armed steps when due */
static void advance(uint64_t us, uint32_t jitter) {
  uint64_t end = g_now + us;
  while (g_now <= end) {
    rfctl_poll(&C, g_now);
    if (g_armed && g_now >= g_armed_t) {
      g_armed = 0;
      if (C.staged == 1) commit(&C, g_armed_t + jitter);
      rfctl_poll(&C, g_now);
    }
    g_now += 10;
  }
}

static void test_safe_at_init(void) {
  /* every DSA at 31.5 dB (all six lines high), every cut at all-off (EN high) */
  for (unsigned b = 0; b < 108; b++) CHECK(bit(g_latched, b) == 1);
  for (unsigned p = 0; p < 6; p++) {
    CHECK(bit(g_latched, 108 + p * 3) == 0);
    CHECK(bit(g_latched, 108 + p * 3 + 2) == 1);
  }
  CHECK(C.value[rfctl_find_device(&C, "dlyA")] == 0);
}

static void test_values(void) {
  const rfctl_device *att = &C.board->dev[rfctl_find_device(&C, "att01a")];
  uint16_t v;
  CHECK(rfctl_parse_value(att, "12.5", &v) == 0 && v == 25);
  CHECK(rfctl_parse_value(att, "0", &v) == 0 && v == 0);
  CHECK(rfctl_parse_value(att, "31.5", &v) == 0 && v == 63);
  CHECK(rfctl_parse_value(att, "32", &v) == -2);
  CHECK(rfctl_parse_value(att, "1.25", &v) == -1);
  CHECK(rfctl_parse_value(att, "max", &v) == 0 && v == 63);
  const rfctl_device *dly = &C.board->dev[rfctl_find_device(&C, "dlyB")];
  CHECK(rfctl_parse_value(dly, "3", &v) == 0 && v == 3);
  CHECK(rfctl_parse_value(dly, "5", &v) == -2);
  CHECK(rfctl_parse_value(dly, "x", &v) == -1);
  char buf[16];
  rfctl_format_value(att, 25, buf, sizeof buf);
  CHECK(!strcmp(buf, "12.5"));
}

static void test_set_encodes_atomically(void) {
  int before = g_commits;
  const char *r = run("@7 set att01a 12.5 cut01 1 dlyA 2");
  CHECK(has(r, "@7 ok set n=3"));
  CHECK(g_commits == before + 1); /* one latch for all three devices */
  /* 12.5 dB = 25 = 0b011001 on bits 0..5 */
  CHECK(bit(g_latched, 0) == 1 && bit(g_latched, 1) == 0 && bit(g_latched, 2) == 0);
  CHECK(bit(g_latched, 3) == 1 && bit(g_latched, 4) == 1 && bit(g_latched, 5) == 0);
  CHECK(bit(g_latched, 110) == 0); /* cut01 EN low = through */
  /* dlyA = 2: both switches select arm 2 (V2 high) */
  CHECK(bit(g_latched, 126) == 0 && bit(g_latched, 127) == 1 && bit(g_latched, 128) == 0);
  CHECK(bit(g_latched, 129) == 0 && bit(g_latched, 130) == 1 && bit(g_latched, 131) == 0);
  CHECK(has(run("get att01a"), "ok get att01a 12.5"));
  CHECK(has(run("set att01a 40"), "err range"));
  CHECK(has(run("set nope 1"), "err unknown_dev nope"));
  CHECK(has(run("set att01a"), "err bad_arg"));
  /* a rejected set changes nothing */
  CHECK(has(run("get att01a"), "12.5"));
  CHECK(has(run("frobnicate"), "err unknown_cmd"));
}

static void test_timeline(void) {
  run("safe");
  CHECK(has(run("clear"), "ok clear"));
  CHECK(has(run("at 1000 cut01 1 cut02 1"), "ok at n=2"));
  CHECK(has(run("at 1000 att01a 0"), "ok at n=3")); /* same instant: same step */
  CHECK(has(run("at 5000 cut01 0"), "ok at n=4"));
  CHECK(has(run("at 4000 cut01 1"), "err order"));
  CHECK(has(run("play +100"), "ok play")); /* first step 1100 us away: beyond the lead */
  run("stop");
  run("clear");
  CHECK(has(run("at 100 cut01 1"), "ok at n=1"));
  CHECK(has(run("play +0"), "err bad_arg")); /* 100 us away: inside the staging lead */
  run("clear");
  run("at 1000 cut01 1 cut02 1");
  run("at 1000 att01a 0");
  run("at 5000 cut01 0");
  CHECK(has(run("play +0"), "ok play")); /* 1000 us away > lead */
  uint64_t t0 = C.t0;
  CHECK(has(run("set cut01 1"), "err busy"));
  advance(1100, 3);
  CHECK(C.steps == 1);
  CHECK(C.value[rfctl_find_device(&C, "cut02")] == 1);
  CHECK(C.value[rfctl_find_device(&C, "att01a")] == 0);
  CHECK(C.late_last_us == 3);
  advance(5000, 0);
  CHECK(C.steps == 2);
  CHECK(!C.playing);
  CHECK(C.value[rfctl_find_device(&C, "cut01")] == 0);
  const char *r = run("log 8");
  char want[64];
  snprintf(want, sizeof want, "step %llu %llu 3 0 3", (unsigned long long)(t0 + 1000),
           (unsigned long long)(t0 + 1003));
  CHECK(has(r, want));
  CHECK(has(r, "ok log n=2"));
  /* staging happens within the lead window, never earlier */
  run("clear");
  run("at 100000 cut13 1");
  run("play +0");
  int shifts = g_shifts;
  advance(100000 - RFCTL_STAGE_LEAD_US - 50, 0);
  CHECK(g_shifts == shifts);
  advance(100, 0);
  CHECK(g_shifts == shifts + 1);
  CHECK(C.staged == 1);
  CHECK(has(run("stop"), "ok stop next=0"));
  CHECK(C.staged == 0);
  advance(1000, 0);
  CHECK(C.value[rfctl_find_device(&C, "cut13")] == 0); /* stopped before commit */
}

static void test_late_fault(void) {
  run("clearfaults");
  run("clear");
  run("latelimit 20");
  run("at 2000 cut23 1");
  run("play +0");
  advance(3000, 120);
  CHECK(C.late_max_us == 120);
  CHECK(C.faults & RFCTL_F_LATE);
  CHECK(has(run("status"), "faults=0x02"));
  run("clearfaults");
  run("latelimit 50");
}

static void test_lease(void) {
  run("safe");
  run("set cut12 1");
  CHECK(has(run("lease 100"), "ok lease ms=100"));
  advance(50000, 0);
  run("ping"); /* any command renews */
  advance(90000, 0);
  CHECK(C.value[rfctl_find_device(&C, "cut12")] == 1);
  advance(20000, 0);
  CHECK(C.value[rfctl_find_device(&C, "cut12")] == 0); /* expired -> safe */
  CHECK(C.faults & RFCTL_F_LEASE);
  CHECK(has(run("status"), "lease_ms_left=-1"));
  run("lease 0");
  CHECK(!(C.faults & RFCTL_F_LEASE));
}

static void test_lease_stops_timeline(void) {
  run("clear");
  run("at 0 cut03 1");
  run("at 500000 cut03 0");
  run("lease 50");
  CHECK(has(run("play +1000"), "ok play"));
  advance(10000, 0);
  CHECK(C.value[rfctl_find_device(&C, "cut03")] == 1);
  advance(100000, 0); /* no traffic for > 50 ms */
  CHECK(!C.playing);
  CHECK(C.value[rfctl_find_device(&C, "cut03")] == 0);
  run("lease 0");
  run("clearfaults");
}

static void test_edges(void) {
  run("cap 0x0005 1000");
  rfctl_edge_push(&C, 0, 111);
  rfctl_edge_push(&C, 1, 112); /* masked */
  rfctl_edge_push(&C, 2, 113);
  const char *r = run("capread 10");
  CHECK(has(r, "ev 0 111"));
  CHECK(!has(r, "ev 1 112"));
  CHECK(has(r, "ev 2 113"));
  CHECK(has(r, "ok capread n=2 left=0"));
  for (int i = 0; i < RFCTL_EDGE_CAP + 5; i++) rfctl_edge_push(&C, 0, (uint64_t)i);
  CHECK(C.edge_dropped == 5);
  CHECK(C.faults & RFCTL_F_EDGE_OVF);
  r = run("capread 3000");
  CHECK(has(r, "left=0"));
  run("clearfaults");
}

static void test_feed_lines(void) {
  g_out_len = 0;
  rfctl_feed(&C, "hel", 3);
  rfctl_feed(&C, "lo\r\n", 4);
  CHECK(has(g_out, "ok rfctl proto=1 board=starter-n4 devices=27 chain=144"));
  char big[400];
  memset(big, 'x', sizeof big);
  g_out_len = 0;
  rfctl_feed(&C, big, sizeof big);
  rfctl_feed(&C, "\n", 1);
  CHECK(has(g_out, "err line_too_long"));
  g_out_len = 0;
  rfctl_feed(&C, "ping\n", 5);
  CHECK(has(g_out, "ok pong"));
}

static void test_list_and_state(void) {
  const char *r = run("list");
  CHECK(has(r, "dev 0 att01a kind=atten max=31.5 safe=31.5"));
  CHECK(has(r, "cut01 kind=switch max=1 safe=0"));
  CHECK(has(r, "ok list n=27"));
  run("safe");
  r = run("state");
  CHECK(has(r, "val dlyB 0"));
  CHECK(has(r, "ok state chain="));
  CHECK(has(run("selftest"), "ok selftest chain=pass bits=144"));
}

int main(void) {
  g_now = 1000000;
  rfctl_init(&C, &rfctl_default_board, wr, NULL);
  test_safe_at_init();
  test_values();
  test_set_encodes_atomically();
  test_timeline();
  test_late_fault();
  test_lease();
  test_lease_stops_timeline();
  test_edges();
  test_feed_lines();
  test_list_and_state();
  if (g_fail) {
    fprintf(stderr, "%d check(s) failed\n", g_fail);
    return 1;
  }
  printf("rfctl_core_test: all passed\n");
  return 0;
}
