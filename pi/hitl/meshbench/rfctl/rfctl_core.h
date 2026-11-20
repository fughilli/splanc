/* rfctl: the mesh-bench RF switch controller (docs/design/mesh-hitl-rig.md §5).
 *
 * Portable core: the device model, the line protocol, the timeline scheduler, the
 * lease watchdog and the frame-start timestamp buffer. No SDK calls: the RP2350
 * build (pico/main.c) and the host simulator (sim/sim_main.c) provide the HAL
 * below, so the simulator runs the exact protocol and scheduling code that ships.
 *
 * Output model. Every control line is either a bit of a 74HC595 shift-register
 * chain (position < RFCTL_DIRECT) or a direct MCU GPIO (RFCTL_DIRECT | gpio). A
 * state change is staged by shifting the whole chain in (outputs unchanged), then
 * committed in one instant: the chain latch (RCLK), the direct GPIOs and the SYNC
 * toggle all move on the same edge. So every switch and attenuator in a step
 * changes together, and the SYNC line marks that instant for the logic analyser.
 */
#ifndef RFCTL_CORE_H
#define RFCTL_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RFCTL_PROTO_VERSION 1
#define RFCTL_MAX_DEVICES 48
#define RFCTL_MAX_LINES 8      /* control lines per device */
#define RFCTL_MAX_CODES 8      /* switch throws (incl. an "off" code) */
#define RFCTL_CHAIN_BITS 256   /* 32 x 74HC595 */
#define RFCTL_DIRECT 0x100u    /* line flag: a direct GPIO, not a chain bit */
#define RFCTL_TIMELINE_CAP 8192
#define RFCTL_LOG_CAP 256
#define RFCTL_EDGE_CAP 2048
#define RFCTL_EDGE_LINES 16
#define RFCTL_LINE_MAX 256
#define RFCTL_STAGE_LEAD_US 400 /* stage (shift in) a step this long before its time */

typedef enum {
  RFCTL_SWITCH = 0,         /* value = index into codes[] (a throw, or an off code) */
  RFCTL_ATTEN_PARALLEL = 1, /* value = half-dB steps; line i = bit i (0.5, 1, 2 ... dB) */
  RFCTL_ATTEN_SERIAL = 2,   /* PE4302 serial: lines = CLK, DATA, LE (direct GPIOs only) */
} rfctl_kind;

typedef struct {
  const char *name;
  uint8_t kind;      /* rfctl_kind */
  uint8_t nlines;
  uint8_t invert;    /* bit i set: line i is active-low */
  uint8_t ncodes;    /* RFCTL_SWITCH: number of codes */
  uint16_t max_value;
  uint16_t safe_value;
  uint16_t line[RFCTL_MAX_LINES];
  uint8_t code[RFCTL_MAX_CODES]; /* RFCTL_SWITCH: raw line pattern per value */
  const char *note;  /* free text for `list` (what the value means) */
} rfctl_device;

typedef struct {
  const char *name;
  uint16_t chain_bits; /* populated chain length (multiple of 8) */
  uint8_t ndevices;
  const rfctl_device *dev;
} rfctl_board;

typedef struct {
  uint32_t t_rel_us; /* from play's t0 */
  uint8_t dev;
  uint16_t value;
} rfctl_entry;

typedef struct {
  uint64_t t_sched;
  uint64_t t_actual;
  uint32_t first, count; /* timeline entries applied */
} rfctl_log;

typedef struct {
  uint8_t line;
  uint64_t t_us;
} rfctl_edge;

/* Faults (status bitmask). */
#define RFCTL_F_LEASE 0x01u    /* lease expired: timeline stopped, safe state applied */
#define RFCTL_F_LATE 0x02u     /* a step committed later than late_limit_us */
#define RFCTL_F_CHAIN 0x04u    /* selftest: chain loopback mismatch */
#define RFCTL_F_EDGE_OVF 0x08u /* frame-start buffer overflowed */

typedef void (*rfctl_write_fn)(void *ctx, const char *s, size_t n);

typedef struct rfctl {
  const rfctl_board *board;
  rfctl_write_fn write;
  void *write_ctx;

  uint16_t value[RFCTL_MAX_DEVICES]; /* committed state */
  uint16_t shadow[RFCTL_MAX_DEVICES];
  uint8_t chain[RFCTL_CHAIN_BITS / 8]; /* committed chain vector */

  rfctl_entry timeline[RFCTL_TIMELINE_CAP];
  uint32_t n_entries;
  uint32_t next; /* next entry to apply */
  bool playing;
  uint64_t t0;

  /* staged step: 0 none, 1 staged (shifted in, waiting), 2 committed by HAL/IRQ */
  volatile int staged;
  uint64_t staged_t;
  uint32_t staged_first, staged_count;
  uint8_t staged_chain[RFCTL_CHAIN_BITS / 8];
  uint64_t staged_gpio_mask, staged_gpio_val;
  volatile uint64_t staged_actual;

  uint32_t steps;
  int64_t late_last_us, late_max_us;
  uint32_t late_limit_us;
  uint32_t faults;
  uint32_t sync_count;

  int64_t lease_deadline; /* <0: no lease */
  uint32_t lease_ms;

  rfctl_log log[RFCTL_LOG_CAP];
  uint32_t log_head, log_n;

  /* frame-start timestamp inputs (FSTI); producer = HAL (IRQ), consumer = capread */
  uint32_t cap_mask;
  uint32_t cap_holdoff_us;
  rfctl_edge edge[RFCTL_EDGE_CAP];
  volatile uint32_t edge_w, edge_r;
  uint32_t edge_dropped;

  char line_buf[RFCTL_LINE_MAX];
  size_t line_len;
  bool line_overflow;
} rfctl;

/* ---- HAL: provided by the platform ---------------------------------------- */
uint64_t rfctl_hal_now_us(void);
/* Shift `nbits` (LSB of bytes[0] = chain bit 0 = the LAST bit shifted) into the
 * chain without latching. Outputs must not change. */
void rfctl_hal_chain_shift(const uint8_t *bytes, uint16_t nbits);
/* Arm the commit of the staged step at absolute time t (or now if t has passed).
 * The platform must, in one instant: latch the chain (if latch_chain), set the
 * direct GPIOs in mask to val, write the serial attenuators (rfctl_serial_words)
 * and toggle SYNC; then call rfctl_committed(c, actual_us) (IRQ context is fine). */
void rfctl_hal_arm_commit(struct rfctl *c, uint64_t t_us);
/* Immediate commit (no timeline): same as the above, synchronous. */
void rfctl_hal_commit_now(struct rfctl *c);
/* Serial attenuator word, MSB first, CLK/DATA/LE on direct GPIOs (bit-banged). */
void rfctl_hal_serial_atten(uint8_t clk, uint8_t data, uint8_t le, uint8_t word6);
/* Shift a pattern through the chain and return what came back on QH' (selftest).
 * Returns false if the platform has no loopback wired. Outputs must not change. */
bool rfctl_hal_chain_loopback(const uint8_t *out, uint8_t *in, uint16_t nbits);
void rfctl_hal_cap_config(uint32_t mask, uint32_t holdoff_us);
void rfctl_hal_bootsel(void);
void rfctl_hal_reset(void);

/* ---- core API ---------------------------------------------------------------- */
void rfctl_init(rfctl *c, const rfctl_board *b, rfctl_write_fn w, void *ctx);
/* Feed received bytes; complete lines are executed. */
void rfctl_feed(rfctl *c, const char *bytes, size_t n);
/* Run one command line (no newline). */
void rfctl_exec(rfctl *c, const char *line);
/* Call often from the main loop: lease, staging of the next step, finishing. */
void rfctl_poll(rfctl *c, uint64_t now_us);
/* HAL -> core: the staged step went out at actual_us. IRQ-safe. */
void rfctl_committed(rfctl *c, uint64_t actual_us);
/* HAL -> core: a frame-start edge on FSTI line `line`. IRQ-safe. */
void rfctl_edge_push(rfctl *c, uint8_t line, uint64_t t_us);
/* Force the safe state now (power-up, lease expiry, `safe`). */
void rfctl_apply_safe(rfctl *c);

/* Helpers the HAL uses inside its commit. */
void rfctl_staged_outputs(const rfctl *c, const uint8_t **chain, uint64_t *gpio_mask,
                          uint64_t *gpio_val);
/* Calls rfctl_hal_serial_atten for every serial attenuator whose staged value
 * changed (all of them when `all`). */
void rfctl_serial_words(rfctl *c, bool all);

/* Pure encoders (exposed for tests). */
int rfctl_find_device(const rfctl *c, const char *name);
int rfctl_parse_value(const rfctl_device *d, const char *s, uint16_t *out);
void rfctl_format_value(const rfctl_device *d, uint16_t v, char *buf, size_t n);
void rfctl_encode(const rfctl_board *b, const uint16_t *values, uint8_t *chain,
                  uint64_t *gpio_mask, uint64_t *gpio_val);

extern const rfctl_board rfctl_default_board;

#ifdef __cplusplus
}
#endif
#endif /* RFCTL_CORE_H */
