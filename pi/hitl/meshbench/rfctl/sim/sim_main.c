/* rfctl host simulator: the shipped core (rfctl_core.c + the board table) behind a
 * simulated HAL, speaking the same line protocol on stdin/stdout.
 *
 *   rfctl_sim            real time (CLOCK_MONOTONIC), for driver demos
 *   rfctl_sim --virtual  time moves only on `sim.advance <us>` (deterministic tests)
 *
 * Extra sim-only commands (never sent to real hardware):
 *   sim.advance <us>            virtual mode: run the clock forward, committing steps
 *   sim.outputs                 the latched chain (hex) and direct GPIOs right now
 *   sim.history [n]             the last n latch events: t, chain hex, gpio, sync
 *   sim.edge <line> <t_us>      inject a frame-start edge (honours mask + holdoff)
 *   sim.loopback pass|fail|absent
 *   sim.jitter <us>             commit this many us after the armed time
 */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <time.h>
#include <unistd.h>

#include "pi/hitl/meshbench/rfctl/rfctl_core.h"

static rfctl g_c;
static int g_virtual;
static uint64_t g_vnow;
static uint64_t g_t_start;
static int g_armed;
static uint64_t g_armed_t;
static uint32_t g_jitter;
static const char *g_loopback = "pass";
static uint8_t g_shift[RFCTL_CHAIN_BITS / 8]; /* shift register contents (unlatched) */
static uint8_t g_latched[RFCTL_CHAIN_BITS / 8];
static uint64_t g_gpio;
static int g_sync;
static uint32_t g_cap_mask, g_cap_holdoff;
static uint64_t g_last_edge[RFCTL_EDGE_LINES];
static int g_have_edge[RFCTL_EDGE_LINES];

#define HIST 1024
static struct {
  uint64_t t;
  uint8_t chain[RFCTL_CHAIN_BITS / 8];
  uint64_t gpio;
  int sync;
} g_hist[HIST];
static unsigned g_hist_n, g_hist_head;

static uint64_t real_us(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000u + (uint64_t)ts.tv_nsec / 1000u;
}

uint64_t rfctl_hal_now_us(void) { return g_virtual ? g_vnow : real_us() - g_t_start; }

void rfctl_hal_chain_shift(const uint8_t *bytes, uint16_t nbits) {
  memcpy(g_shift, bytes, nbits / 8);
}

static void do_commit(rfctl *c, uint64_t t) {
  const uint8_t *chain;
  uint64_t mask, val;
  rfctl_staged_outputs(c, &chain, &mask, &val);
  (void)chain; /* the latch copies the shift register, which holds the staged vector */
  memcpy(g_latched, g_shift, sizeof g_latched);
  g_gpio = (g_gpio & ~mask) | (val & mask);
  rfctl_serial_words(c, false);
  g_sync ^= 1;
  unsigned i = g_hist_head;
  g_hist[i].t = t;
  memcpy(g_hist[i].chain, g_latched, sizeof g_latched);
  g_hist[i].gpio = g_gpio;
  g_hist[i].sync = g_sync;
  g_hist_head = (g_hist_head + 1) % HIST;
  if (g_hist_n < HIST) g_hist_n++;
  rfctl_committed(c, t);
}

void rfctl_hal_arm_commit(struct rfctl *c, uint64_t t_us) {
  (void)c;
  g_armed = 1;
  g_armed_t = t_us;
}

void rfctl_hal_commit_now(struct rfctl *c) { do_commit(c, rfctl_hal_now_us()); }

void rfctl_hal_serial_atten(uint8_t clk, uint8_t data, uint8_t le, uint8_t word6) {
  (void)clk;
  (void)data;
  (void)le;
  (void)word6;
}

bool rfctl_hal_chain_loopback(const uint8_t *outb, uint8_t *in, uint16_t nbits) {
  if (!strcmp(g_loopback, "absent")) return false;
  memcpy(in, outb, nbits / 8);
  if (!strcmp(g_loopback, "fail")) in[0] ^= 0x10;
  memcpy(g_shift, outb, nbits / 8);
  return true;
}

void rfctl_hal_cap_config(uint32_t mask, uint32_t holdoff_us) {
  g_cap_mask = mask;
  g_cap_holdoff = holdoff_us;
  memset(g_have_edge, 0, sizeof g_have_edge);
}

void rfctl_hal_bootsel(void) {}
void rfctl_hal_reset(void) {}

static void write_stdout(void *ctx, const char *s, size_t n) {
  (void)ctx;
  fwrite(s, 1, n, stdout);
  fflush(stdout);
}

static void service(uint64_t now) {
  rfctl_poll(&g_c, now);
  if (g_armed && now >= g_armed_t) {
    g_armed = 0;
    if (g_c.staged == 1) do_commit(&g_c, g_virtual ? g_armed_t + g_jitter : now);
    rfctl_poll(&g_c, now);
  }
}

static void hexdump(const uint8_t *chain, char *buf, size_t n) {
  size_t bytes = rfctl_default_board.chain_bits / 8, k = 0;
  for (size_t i = bytes; i-- > 0 && k + 3 < n;) k += (size_t)snprintf(buf + k, n - k, "%02x", chain[i]);
}

static int sim_cmd(const char *line) {
  char hex[RFCTL_CHAIN_BITS / 4 + 4];
  if (strncmp(line, "sim.", 4)) return 0;
  if (!strncmp(line, "sim.advance ", 12)) {
    uint64_t target = g_vnow + strtoull(line + 12, NULL, 0);
    if (!g_virtual) {
      printf("err sim not in --virtual mode\n");
    } else {
      while (g_vnow < target) {
        service(g_vnow);
        uint64_t step = g_vnow + 50;
        if (g_armed && g_armed_t > g_vnow && g_armed_t < step) step = g_armed_t;
        if (step > target) step = target;
        g_vnow = step;
      }
      service(g_vnow);
      printf("ok sim.advance t=%llu\n", (unsigned long long)g_vnow);
    }
  } else if (!strcmp(line, "sim.outputs")) {
    hexdump(g_latched, hex, sizeof hex);
    printf("ok sim.outputs chain=%s gpio=0x%llx sync=%d\n", hex, (unsigned long long)g_gpio, g_sync);
  } else if (!strncmp(line, "sim.history", 11)) {
    unsigned n = line[11] ? (unsigned)strtoul(line + 12, NULL, 0) : 16;
    if (n > g_hist_n) n = g_hist_n;
    for (unsigned i = n; i > 0; i--) {
      unsigned k = (g_hist_head + HIST - i) % HIST;
      hexdump(g_hist[k].chain, hex, sizeof hex);
      printf("latch %llu %s 0x%llx %d\n", (unsigned long long)g_hist[k].t, hex,
             (unsigned long long)g_hist[k].gpio, g_hist[k].sync);
    }
    printf("ok sim.history n=%u\n", n);
  } else if (!strncmp(line, "sim.edge ", 9)) {
    char *end;
    unsigned ln = (unsigned)strtoul(line + 9, &end, 0);
    uint64_t t = strtoull(end, NULL, 0);
    int accepted = 0;
    if (ln < RFCTL_EDGE_LINES && ((g_cap_mask >> ln) & 1u) &&
        (!g_have_edge[ln] || t >= g_last_edge[ln] + g_cap_holdoff)) {
      g_have_edge[ln] = 1;
      g_last_edge[ln] = t;
      rfctl_edge_push(&g_c, (uint8_t)ln, t);
      accepted = 1;
    }
    printf("ok sim.edge accepted=%d\n", accepted);
  } else if (!strncmp(line, "sim.loopback ", 13)) {
    const char *m = line + 13;
    g_loopback = !strcmp(m, "fail") ? "fail" : !strcmp(m, "absent") ? "absent" : "pass";
    printf("ok sim.loopback %s\n", g_loopback);
  } else if (!strncmp(line, "sim.jitter ", 11)) {
    g_jitter = (uint32_t)strtoul(line + 11, NULL, 0);
    printf("ok sim.jitter us=%u\n", g_jitter);
  } else {
    printf("err unknown_cmd %s\n", line);
  }
  fflush(stdout);
  return 1;
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++)
    if (!strcmp(argv[i], "--virtual")) g_virtual = 1;
  g_t_start = real_us();
  rfctl_init(&g_c, &rfctl_default_board, write_stdout, NULL);
  char line[RFCTL_LINE_MAX * 2];
  size_t len = 0;
  for (;;) {
    if (!g_virtual) service(rfctl_hal_now_us());
    fd_set fds;
    FD_ZERO(&fds);
    FD_SET(0, &fds);
    struct timeval tv = {0, g_virtual ? 200000 : 100};
    int r = select(1, &fds, NULL, NULL, &tv);
    if (r < 0) break;
    if (r == 0) continue;
    char buf[512];
    ssize_t n = read(0, buf, sizeof buf);
    if (n <= 0) break;
    for (ssize_t i = 0; i < n; i++) {
      if (buf[i] == '\n') {
        line[len] = 0;
        if (!sim_cmd(line)) {
          rfctl_feed(&g_c, line, len);
          rfctl_feed(&g_c, "\n", 1);
        }
        len = 0;
        if (!g_virtual) service(rfctl_hal_now_us());
      } else if (len < sizeof line - 1) {
        line[len++] = buf[i];
      }
    }
  }
  return 0;
}
