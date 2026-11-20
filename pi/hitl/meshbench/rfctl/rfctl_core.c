/* rfctl core: see rfctl_core.h and docs/design/mesh-hitl-rig.md §5 (protocol). */
#include "rfctl_core.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_TOKENS 48
#define FAIL(...)            \
  do {                       \
    out(c, tag, __VA_ARGS__); \
    return;                  \
  } while (0)

enum { STAGED_NONE = 0, STAGED_READY = 1, STAGED_DONE = 2 };
enum { KIND_IMMEDIATE = 0, KIND_STEP = 1 };
static int g_staged_kind; /* one controller per process */

static const char *kind_name(uint8_t k) {
  switch (k) {
    case RFCTL_SWITCH: return "switch";
    case RFCTL_ATTEN_PARALLEL: return "atten";
    case RFCTL_ATTEN_SERIAL: return "atten_serial";
    case RFCTL_ATTEN_UART: return "atten_uart";
  }
  return "?";
}

static bool is_atten(const rfctl_device *d) {
  return d->kind == RFCTL_ATTEN_PARALLEL || d->kind == RFCTL_ATTEN_SERIAL ||
         d->kind == RFCTL_ATTEN_UART;
}

/* hundredths of a dB per value step: 0.5 dB for the DSAs, 0.25 dB for UART units */
static unsigned step_cdb(const rfctl_device *d) { return d->kind == RFCTL_ATTEN_UART ? 25u : 50u; }

/* ---- output ------------------------------------------------------------------ */

static void out(rfctl *c, const char *tag, const char *fmt, ...) {
  char buf[RFCTL_LINE_MAX + 64];
  size_t n = 0;
  if (tag && *tag) n = (size_t)snprintf(buf, sizeof buf, "@%s ", tag);
  va_list ap;
  va_start(ap, fmt);
  int k = vsnprintf(buf + n, sizeof buf - n - 1, fmt, ap);
  va_end(ap);
  if (k < 0) k = 0;
  n += (size_t)k;
  if (n > sizeof buf - 2) n = sizeof buf - 2;
  buf[n++] = '\n';
  c->write(c->write_ctx, buf, n);
}

/* ---- encoding ------------------------------------------------------------------ */

static void set_line(uint16_t line, int bit, uint8_t *chain, uint64_t *mask, uint64_t *val) {
  if (line & RFCTL_DIRECT) {
    unsigned g = line & 0xffu;
    *mask |= 1ull << g;
    if (bit) *val |= 1ull << g;
    else *val &= ~(1ull << g);
  } else if (line < RFCTL_CHAIN_BITS) {
    if (bit) chain[line >> 3] |= (uint8_t)(1u << (line & 7));
    else chain[line >> 3] &= (uint8_t)~(1u << (line & 7));
  }
}

void rfctl_encode(const rfctl_board *b, const uint16_t *values, uint8_t *chain,
                  uint64_t *gpio_mask, uint64_t *gpio_val) {
  /* bits no device owns sit at their pull level (high) on boards that ask for it */
  memset(chain, b->spare_high ? 0xff : 0, RFCTL_CHAIN_BITS / 8);
  *gpio_mask = 0;
  *gpio_val = 0;
  for (unsigned i = 0; i < b->ndevices; i++) {
    const rfctl_device *d = &b->dev[i];
    uint32_t pattern;
    if (d->kind == RFCTL_SWITCH) {
      pattern = values[i] < d->ncodes ? d->code[values[i]] : d->code[d->safe_value];
    } else if (d->kind == RFCTL_ATTEN_PARALLEL) {
      pattern = values[i];
    } else {
      continue; /* serial and UART attenuators are written by their own helpers */
    }
    for (unsigned k = 0; k < d->nlines; k++) {
      int bit = (int)((pattern >> k) & 1u) ^ (int)((d->invert >> k) & 1u);
      set_line(d->line[k], bit, chain, gpio_mask, gpio_val);
    }
  }
}

int rfctl_find_device(const rfctl *c, const char *name) {
  for (unsigned i = 0; i < c->board->ndevices; i++)
    if (strcmp(c->board->dev[i].name, name) == 0) return (int)i;
  /* numeric index */
  char *end;
  long v = strtol(name, &end, 10);
  if (*name && *end == 0 && v >= 0 && v < c->board->ndevices) return (int)v;
  return -1;
}

int rfctl_parse_value(const rfctl_device *d, const char *s, uint16_t *outv) {
  if (strcmp(s, "safe") == 0) {
    *outv = d->safe_value;
    return 0;
  }
  if (is_atten(d)) {
    if (strcmp(s, "max") == 0) {
      *outv = d->max_value;
      return 0;
    }
    /* decimal dB with up to two decimals, a multiple of the device's step */
    if (*s < '0' || *s > '9') return -1;
    char *end;
    long whole = strtol(s, &end, 10);
    if (end == s || whole < 0 || whole > 1000) return -1;
    long frac = 0;
    if (*end == '.') {
      const char *f = end + 1;
      int nd = 0;
      while (f[nd] >= '0' && f[nd] <= '9' && nd < 3) nd++;
      if (nd == 0 || nd > 2 || f[nd] != 0) return -1;
      frac = (f[0] - '0') * 10 + (nd == 2 ? f[1] - '0' : 0);
    } else if (*end != 0) {
      return -1;
    }
    long cdb = whole * 100 + frac;
    unsigned st = step_cdb(d);
    if (cdb % (long)st) return -1;
    long v = cdb / (long)st;
    if (v > d->max_value) return -2;
    *outv = (uint16_t)v;
    return 0;
  }
  char *end;
  long v = strtol(s, &end, 10);
  if (end == s || *end != 0 || v < 0) return -1;
  if (v > d->max_value || v >= d->ncodes) return -2;
  *outv = (uint16_t)v;
  return 0;
}

void rfctl_format_value(const rfctl_device *d, uint16_t v, char *buf, size_t n) {
  if (is_atten(d)) {
    unsigned cdb = (unsigned)v * step_cdb(d), frac = cdb % 100;
    if (frac % 10) snprintf(buf, n, "%u.%02u", cdb / 100, frac); /* 12.25 */
    else snprintf(buf, n, "%u.%u", cdb / 100, frac / 10);       /* 12.5, 31.0 */
  } else {
    snprintf(buf, n, "%u", (unsigned)v);
  }
}

int rfctl_uart_format(uint16_t q, char *buf, size_t n) {
  /* hand-rolled (no printf): this runs in the commit IRQ */
  if (n < RFCTL_UART_CMD_LEN + 1) return 0;
  unsigned cdb = (unsigned)q * 25u;
  if (cdb > 9999u) cdb = 9999u;
  buf[0] = 'w';
  buf[1] = 'v';
  buf[2] = '0';
  buf[3] = (char)('0' + cdb / 1000);
  buf[4] = (char)('0' + cdb / 100 % 10);
  buf[5] = (char)('0' + cdb / 10 % 10);
  buf[6] = (char)('0' + cdb % 10);
  buf[7] = '\n';
  buf[8] = 0;
  return RFCTL_UART_CMD_LEN;
}

/* ---- staging and commit ------------------------------------------------------------ */

static void stage(rfctl *c) {
  rfctl_encode(c->board, c->shadow, c->staged_chain, &c->staged_gpio_mask, &c->staged_gpio_val);
  if (c->board->chain_bits) rfctl_hal_chain_shift(c->staged_chain, c->board->chain_bits);
}

void rfctl_staged_outputs(const rfctl *c, const uint8_t **chain, uint64_t *gpio_mask,
                          uint64_t *gpio_val) {
  *chain = c->staged_chain;
  *gpio_mask = c->staged_gpio_mask;
  *gpio_val = c->staged_gpio_val;
}

void rfctl_serial_words(rfctl *c, bool all) {
  for (unsigned i = 0; i < c->board->ndevices; i++) {
    const rfctl_device *d = &c->board->dev[i];
    if (d->kind != RFCTL_ATTEN_SERIAL) continue;
    if (!all && c->shadow[i] == c->value[i]) continue;
    uint8_t w = (uint8_t)(c->shadow[i] & 0x3f);
    if (d->invert) w = (uint8_t)(~w & 0x3f);
    rfctl_hal_serial_atten((uint8_t)(d->line[0] & 0xff), (uint8_t)(d->line[1] & 0xff),
                           (uint8_t)(d->line[2] & 0xff), w);
  }
  rfctl_uart_words(c, all); /* UART units start right after the latch edge */
}

static bool uart_send_value(rfctl *c, unsigned i, uint16_t v) {
  const rfctl_device *d = &c->board->dev[i];
  char cmd[RFCTL_UART_CMD_LEN + 1];
  int n = rfctl_uart_format(v, cmd, sizeof cmd);
  if (!rfctl_hal_uart_send(d->aux, (uint8_t)(d->line[0] & 0xff), cmd, (uint8_t)n)) return false;
  c->uart_sent++;
  return true;
}

void rfctl_uart_words(rfctl *c, bool all) {
  for (unsigned i = 0; i < c->board->ndevices; i++) {
    if (c->board->dev[i].kind != RFCTL_ATTEN_UART) continue;
    if (!all && c->shadow[i] == c->value[i] && !c->uart_pending[i]) continue;
    if (uart_send_value(c, i, c->shadow[i])) {
      c->uart_pending[i] = 0;
    } else {
      /* the unit is still sending its previous command: rfctl_poll sends the
       * committed value as soon as it can (counted, and flagged as a fault) */
      c->uart_pending[i] = 1;
      c->uart_deferred++;
      c->faults |= RFCTL_F_UART;
    }
  }
}

static void uart_service(rfctl *c, uint64_t now) {
  for (unsigned i = 0; i < c->board->ndevices; i++)
    if (c->uart_pending[i] && uart_send_value(c, i, c->value[i])) c->uart_pending[i] = 0;
  /* the units power up at 0 dB and may boot after the controller: repeat the
   * committed values for a while after every safe state */
  if (!c->playing && now < c->uart_refresh_until && now >= c->uart_refresh_next) {
    c->uart_refresh_next = now + RFCTL_UART_REFRESH_US;
    for (unsigned i = 0; i < c->board->ndevices; i++)
      if (c->board->dev[i].kind == RFCTL_ATTEN_UART && !c->uart_pending[i])
        (void)uart_send_value(c, i, c->value[i]);
  }
}

static void finish(rfctl *c) {
  memcpy(c->value, c->shadow, sizeof c->value);
  memcpy(c->chain, c->staged_chain, sizeof c->chain);
  c->sync_count++;
}

void rfctl_committed(rfctl *c, uint64_t actual_us) {
  c->staged_actual = actual_us;
  if (g_staged_kind == KIND_IMMEDIATE) {
    finish(c);
    c->staged = STAGED_NONE;
  } else {
    c->staged = STAGED_DONE; /* rfctl_poll finishes it outside IRQ context */
  }
}

static uint64_t commit_immediate(rfctl *c) {
  g_staged_kind = KIND_IMMEDIATE;
  stage(c);
  c->staged = STAGED_READY;
  rfctl_hal_commit_now(c);
  return c->staged_actual;
}

void rfctl_apply_safe(rfctl *c) {
  c->playing = false;
  c->staged = STAGED_NONE; /* a pending alarm sees this and does nothing */
  for (unsigned i = 0; i < c->board->ndevices; i++) c->shadow[i] = c->board->dev[i].safe_value;
  g_staged_kind = KIND_IMMEDIATE;
  stage(c);
  c->staged = STAGED_READY;
  /* the serial and UART attenuators must all be written at power-up */
  for (unsigned i = 0; i < c->board->ndevices; i++) c->value[i] = (uint16_t)~c->shadow[i];
  rfctl_hal_commit_now(c);
  uint64_t now = rfctl_hal_now_us();
  c->uart_refresh_next = now + RFCTL_UART_REFRESH_US;
  c->uart_refresh_until = now + RFCTL_UART_REFRESH_FOR_US;
}

static void finish_step(rfctl *c) {
  finish(c);
  int64_t late = (int64_t)(c->staged_actual - c->staged_t);
  c->late_last_us = late;
  if (late > c->late_max_us) c->late_max_us = late;
  if (late > (int64_t)c->late_limit_us) c->faults |= RFCTL_F_LATE;
  rfctl_log *l = &c->log[c->log_head];
  l->t_sched = c->staged_t;
  l->t_actual = c->staged_actual;
  l->first = c->staged_first;
  l->count = c->staged_count;
  c->log_head = (c->log_head + 1) % RFCTL_LOG_CAP;
  if (c->log_n < RFCTL_LOG_CAP) c->log_n++;
  c->steps++;
  c->next = c->staged_first + c->staged_count;
  c->staged = STAGED_NONE;
  if (c->next >= c->n_entries) c->playing = false;
}

void rfctl_poll(rfctl *c, uint64_t now) {
  if (c->staged == STAGED_DONE) finish_step(c);
  uart_service(c, now);
  if (c->lease_deadline >= 0 && (int64_t)now > c->lease_deadline) {
    c->faults |= RFCTL_F_LEASE;
    c->lease_deadline = -1;
    c->lease_ms = 0;
    rfctl_apply_safe(c);
    return;
  }
  if (!c->playing || c->staged != STAGED_NONE || c->next >= c->n_entries) return;
  uint32_t t_rel = c->timeline[c->next].t_rel_us;
  uint64_t t = c->t0 + t_rel;
  if (t > now + RFCTL_STAGE_LEAD_US) return;
  uint32_t first = c->next, k = first;
  memcpy(c->shadow, c->value, sizeof c->shadow);
  while (k < c->n_entries && c->timeline[k].t_rel_us == t_rel) {
    c->shadow[c->timeline[k].dev] = c->timeline[k].value;
    k++;
  }
  c->staged_first = first;
  c->staged_count = k - first;
  c->staged_t = t;
  g_staged_kind = KIND_STEP;
  stage(c);
  c->staged = STAGED_READY;
  rfctl_hal_arm_commit(c, t);
}

void rfctl_edge_push(rfctl *c, uint8_t line, uint64_t t_us) {
  if (line >= RFCTL_EDGE_LINES || !((c->cap_mask >> line) & 1u)) return;
  uint32_t w = c->edge_w;
  if (w - c->edge_r >= RFCTL_EDGE_CAP) {
    c->edge_dropped++;
    c->faults |= RFCTL_F_EDGE_OVF;
    return;
  }
  c->edge[w % RFCTL_EDGE_CAP].line = line;
  c->edge[w % RFCTL_EDGE_CAP].t_us = t_us;
  c->edge_w = w + 1;
}

/* ---- commands ------------------------------------------------------------------- */

static void cmd_list(rfctl *c, const char *tag) {
  char v[16], s[16], m[16];
  for (unsigned i = 0; i < c->board->ndevices; i++) {
    const rfctl_device *d = &c->board->dev[i];
    rfctl_format_value(d, c->value[i], v, sizeof v);
    rfctl_format_value(d, d->safe_value, s, sizeof s);
    rfctl_format_value(d, d->kind == RFCTL_SWITCH ? (uint16_t)(d->ncodes - 1) : d->max_value, m,
                       sizeof m);
    out(c, tag, "dev %u %s kind=%s max=%s safe=%s value=%s note=\"%s\"", i, d->name,
        kind_name(d->kind), m, s, v, d->note ? d->note : "");
  }
  out(c, tag, "ok list n=%u", (unsigned)c->board->ndevices);
}

static void chain_hex(const rfctl *c, const uint8_t *chain, char *buf, size_t n) {
  size_t bytes = c->board->chain_bits / 8, k = 0;
  /* most significant byte first */
  for (size_t i = bytes; i-- > 0 && k + 3 < n;) k += (size_t)snprintf(buf + k, n - k, "%02x", chain[i]);
  if (bytes == 0 && n > 1) snprintf(buf, n, "-");
}

static int parse_pairs(rfctl *c, char **tok, int ntok, uint16_t *vals, uint8_t *devs, int *npairs,
                       const char *tag) {
  if (ntok <= 0 || ntok % 2) {
    out(c, tag, "err bad_arg expected <dev> <value> pairs");
    return -1;
  }
  *npairs = 0;
  for (int i = 0; i < ntok; i += 2) {
    int d = rfctl_find_device(c, tok[i]);
    if (d < 0) {
      out(c, tag, "err unknown_dev %s", tok[i]);
      return -1;
    }
    uint16_t v;
    int r = rfctl_parse_value(&c->board->dev[d], tok[i + 1], &v);
    if (r == -2) {
      out(c, tag, "err range %s %s", tok[i], tok[i + 1]);
      return -1;
    }
    if (r) {
      out(c, tag, "err bad_arg %s %s", tok[i], tok[i + 1]);
      return -1;
    }
    devs[*npairs] = (uint8_t)d;
    vals[*npairs] = v;
    (*npairs)++;
  }
  return 0;
}

static bool parse_u64(const char *s, uint64_t *v) {
  char *end;
  if (!*s) return false;
  unsigned long long x = strtoull(s, &end, 0);
  if (*end) return false;
  *v = x;
  return true;
}

void rfctl_exec(rfctl *c, const char *line) {
  char buf[RFCTL_LINE_MAX];
  strncpy(buf, line, sizeof buf - 1);
  buf[sizeof buf - 1] = 0;
  char *tok[MAX_TOKENS];
  int ntok = 0;
  for (char *p = strtok(buf, " \t"); p && ntok < MAX_TOKENS; p = strtok(NULL, " \t")) tok[ntok++] = p;
  if (ntok == 0) return;
  const char *tag = NULL;
  if (tok[0][0] == '@') {
    tag = tok[0] + 1;
    memmove(tok, tok + 1, (size_t)(ntok - 1) * sizeof tok[0]);
    ntok--;
    if (ntok == 0) return;
  }
  uint64_t now = rfctl_hal_now_us();
  if (c->lease_ms) c->lease_deadline = (int64_t)(now + (uint64_t)c->lease_ms * 1000u);
  const char *cmd = tok[0];
  char **arg = tok + 1;
  int nargs = ntok - 1;

  if (!strcmp(cmd, "hello")) {
    unsigned nuart = 0;
    for (unsigned i = 0; i < c->board->ndevices; i++) nuart += c->board->dev[i].kind == RFCTL_ATTEN_UART;
    out(c, tag,
        "ok rfctl proto=%d board=%s devices=%u chain=%u timeline_cap=%u edge_lines=%u uart=%u",
        RFCTL_PROTO_VERSION, c->board->name, (unsigned)c->board->ndevices,
        (unsigned)c->board->chain_bits, (unsigned)RFCTL_TIMELINE_CAP, (unsigned)RFCTL_EDGE_LINES,
        nuart);
  } else if (!strcmp(cmd, "help")) {
    out(c, tag, "# hello list get set safe time ping at clear play stop status state lease");
    out(c, tag, "# clearfaults latelimit cap capread log selftest attcheck bootsel reset");
    out(c, tag, "ok help");
  } else if (!strcmp(cmd, "list")) {
    cmd_list(c, tag);
  } else if (!strcmp(cmd, "get")) {
    if (nargs != 1) FAIL("err bad_arg get <dev>");
    int d = rfctl_find_device(c, arg[0]);
    if (d < 0) FAIL("err unknown_dev %s", arg[0]);
    char v[16];
    rfctl_format_value(&c->board->dev[d], c->value[d], v, sizeof v);
    out(c, tag, "ok get %s %s", c->board->dev[d].name, v);
  } else if (!strcmp(cmd, "set")) {
    if (c->playing) FAIL("err busy timeline playing (stop first)");
    uint16_t vals[MAX_TOKENS];
    uint8_t devs[MAX_TOKENS];
    int np;
    if (parse_pairs(c, arg, nargs, vals, devs, &np, tag)) return;
    memcpy(c->shadow, c->value, sizeof c->shadow);
    for (int i = 0; i < np; i++) c->shadow[devs[i]] = vals[i];
    uint64_t t = commit_immediate(c);
    out(c, tag, "ok set n=%d t=%llu", np, (unsigned long long)t);
  } else if (!strcmp(cmd, "safe")) {
    rfctl_apply_safe(c);
    out(c, tag, "ok safe t=%llu", (unsigned long long)c->staged_actual);
  } else if (!strcmp(cmd, "time")) {
    out(c, tag, "ok time=%llu", (unsigned long long)now);
  } else if (!strcmp(cmd, "ping")) {
    out(c, tag, "ok pong t=%llu", (unsigned long long)now);
  } else if (!strcmp(cmd, "at")) {
    if (c->playing) FAIL("err busy timeline playing (stop first)");
    uint64_t t;
    if (nargs < 3 || !parse_u64(arg[0], &t) || t > 0xffffffffull)
      FAIL("err bad_arg at <t_rel_us> <dev> <value> [...]");
    if (c->n_entries && t < c->timeline[c->n_entries - 1].t_rel_us)
      FAIL("err order t_rel_us %llu before the previous entry", (unsigned long long)t);
    uint16_t vals[MAX_TOKENS];
    uint8_t devs[MAX_TOKENS];
    int np;
    if (parse_pairs(c, arg + 1, nargs - 1, vals, devs, &np, tag)) return;
    if (c->n_entries + (uint32_t)np > RFCTL_TIMELINE_CAP) FAIL("err full timeline");
    for (int i = 0; i < np; i++) {
      rfctl_entry *e = &c->timeline[c->n_entries++];
      e->t_rel_us = (uint32_t)t;
      e->dev = devs[i];
      e->value = vals[i];
    }
    out(c, tag, "ok at n=%u", (unsigned)c->n_entries);
  } else if (!strcmp(cmd, "clear")) {
    if (c->playing) FAIL("err busy timeline playing (stop first)");
    c->n_entries = 0;
    c->next = 0;
    out(c, tag, "ok clear");
  } else if (!strcmp(cmd, "play")) {
    if (c->playing) FAIL("err busy already playing");
    if (c->n_entries == 0) FAIL("err bad_arg empty timeline");
    if (nargs != 1) FAIL("err bad_arg play <t0_us>|+<delay_us>");
    uint64_t t0;
    if (arg[0][0] == '+') {
      uint64_t d;
      if (!parse_u64(arg[0] + 1, &d)) FAIL("err bad_arg %s", arg[0]);
      t0 = now + d;
    } else if (!parse_u64(arg[0], &t0)) {
      FAIL("err bad_arg %s", arg[0]);
    }
    if (t0 + c->timeline[0].t_rel_us < now + RFCTL_STAGE_LEAD_US)
      FAIL("err bad_arg first step is less than %u us away", RFCTL_STAGE_LEAD_US);
    c->t0 = t0;
    c->next = 0;
    c->playing = true;
    out(c, tag, "ok play t0=%llu n=%u", (unsigned long long)t0, (unsigned)c->n_entries);
  } else if (!strcmp(cmd, "stop")) {
    c->playing = false;
    if (c->staged == STAGED_READY && g_staged_kind == KIND_STEP) c->staged = STAGED_NONE;
    if (c->staged == STAGED_DONE) finish_step(c);
    /* re-shift the committed vector so the chain holds what the outputs show */
    if (c->board->chain_bits) rfctl_hal_chain_shift(c->chain, c->board->chain_bits);
    out(c, tag, "ok stop next=%u", (unsigned)c->next);
  } else if (!strcmp(cmd, "status")) {
    long long left = c->lease_deadline < 0 ? -1 : ((long long)c->lease_deadline - (long long)now) / 1000;
    out(c, tag,
        "ok status playing=%d next=%u n=%u t=%llu t0=%llu steps=%u late_last_us=%lld "
        "late_max_us=%lld late_limit_us=%u faults=0x%02x lease_ms_left=%lld sync=%u cap_mask=0x%04x "
        "edges=%u dropped=%u uart_sent=%u uart_deferred=%u",
        c->playing ? 1 : 0, (unsigned)c->next, (unsigned)c->n_entries, (unsigned long long)now,
        (unsigned long long)c->t0, (unsigned)c->steps, (long long)c->late_last_us,
        (long long)c->late_max_us, (unsigned)c->late_limit_us, (unsigned)c->faults, left,
        (unsigned)c->sync_count, (unsigned)c->cap_mask, (unsigned)(c->edge_w - c->edge_r),
        (unsigned)c->edge_dropped, (unsigned)c->uart_sent, (unsigned)c->uart_deferred);
  } else if (!strcmp(cmd, "state")) {
    char v[16], hex[RFCTL_CHAIN_BITS / 4 + 4];
    for (unsigned i = 0; i < c->board->ndevices; i++) {
      rfctl_format_value(&c->board->dev[i], c->value[i], v, sizeof v);
      out(c, tag, "val %s %s", c->board->dev[i].name, v);
    }
    chain_hex(c, c->chain, hex, sizeof hex);
    out(c, tag, "ok state chain=%s", hex);
  } else if (!strcmp(cmd, "lease")) {
    uint64_t ms;
    if (nargs != 1 || !parse_u64(arg[0], &ms) || ms > 3600000u)
      FAIL("err bad_arg lease <ms> (0 = off)");
    c->lease_ms = (uint32_t)ms;
    c->lease_deadline = ms ? (int64_t)(now + ms * 1000u) : -1;
    c->faults &= ~RFCTL_F_LEASE;
    out(c, tag, "ok lease ms=%u", (unsigned)ms);
  } else if (!strcmp(cmd, "clearfaults")) {
    c->faults = 0;
    c->late_max_us = 0;
    out(c, tag, "ok clearfaults");
  } else if (!strcmp(cmd, "latelimit")) {
    uint64_t us;
    if (nargs != 1 || !parse_u64(arg[0], &us)) FAIL("err bad_arg latelimit <us>");
    c->late_limit_us = (uint32_t)us;
    out(c, tag, "ok latelimit us=%u", (unsigned)us);
  } else if (!strcmp(cmd, "cap")) {
    uint64_t mask, hold = c->cap_holdoff_us;
    if (nargs < 1 || nargs > 2 || !parse_u64(arg[0], &mask) || mask >> RFCTL_EDGE_LINES ||
        (nargs == 2 && !parse_u64(arg[1], &hold)))
      FAIL("err bad_arg cap <mask> [holdoff_us]");
    c->cap_mask = (uint32_t)mask;
    c->cap_holdoff_us = (uint32_t)hold;
    rfctl_hal_cap_config(c->cap_mask, c->cap_holdoff_us);
    out(c, tag, "ok cap mask=0x%04x holdoff_us=%u", (unsigned)c->cap_mask,
        (unsigned)c->cap_holdoff_us);
  } else if (!strcmp(cmd, "capread")) {
    uint64_t max = 64;
    if (nargs == 1 && !parse_u64(arg[0], &max)) FAIL("err bad_arg capread [max]");
    unsigned n = 0;
    while (n < max && c->edge_r != c->edge_w) {
      rfctl_edge e = c->edge[c->edge_r % RFCTL_EDGE_CAP];
      c->edge_r++;
      out(c, tag, "ev %u %llu", (unsigned)e.line, (unsigned long long)e.t_us);
      n++;
    }
    out(c, tag, "ok capread n=%u left=%u dropped=%u", n, (unsigned)(c->edge_w - c->edge_r),
        (unsigned)c->edge_dropped);
  } else if (!strcmp(cmd, "log")) {
    uint64_t max = 32;
    if (nargs == 1 && !parse_u64(arg[0], &max)) FAIL("err bad_arg log [max]");
    unsigned n = c->log_n < max ? c->log_n : (unsigned)max;
    for (unsigned i = n; i > 0; i--) {
      const rfctl_log *l = &c->log[(c->log_head + RFCTL_LOG_CAP - i) % RFCTL_LOG_CAP];
      out(c, tag, "step %llu %llu %lld %u %u", (unsigned long long)l->t_sched,
          (unsigned long long)l->t_actual, (long long)(l->t_actual - l->t_sched), (unsigned)l->first,
          (unsigned)l->count);
    }
    out(c, tag, "ok log n=%u", n);
  } else if (!strcmp(cmd, "selftest")) {
    if (c->playing) FAIL("err busy timeline playing (stop first)");
    uint16_t nbits = c->board->chain_bits;
    uint8_t pat[RFCTL_CHAIN_BITS / 8], in[RFCTL_CHAIN_BITS / 8];
    for (unsigned i = 0; i < sizeof pat; i++) pat[i] = (uint8_t)(0xa5u ^ (i * 29u));
    memset(in, 0, sizeof in);
    const char *res;
    if (!nbits) res = "absent";
    else if (!rfctl_hal_chain_loopback(pat, in, nbits)) res = "absent";
    else if (memcmp(pat, in, nbits / 8)) {
      res = "fail";
      c->faults |= RFCTL_F_CHAIN;
    } else res = "pass";
    if (nbits) rfctl_hal_chain_shift(c->chain, nbits); /* restore; outputs never moved */
    out(c, tag, "ok selftest chain=%s bits=%u", res, (unsigned)nbits);
  } else if (!strcmp(cmd, "attcheck")) {
    /* re-send every UART attenuator's committed value, one unit at a time, and wait
     * for its "ok" on the shared acknowledge line (idempotent; outputs unchanged) */
    if (c->playing) FAIL("err busy timeline playing (stop first)");
    unsigned n = 0, good = 0;
    for (unsigned i = 0; i < c->board->ndevices; i++) {
      const rfctl_device *d = &c->board->dev[i];
      if (d->kind != RFCTL_ATTEN_UART) continue;
      if (nargs) {
        bool want = false;
        for (int a = 0; a < nargs; a++) want |= rfctl_find_device(c, arg[a]) == (int)i;
        if (!want) continue;
      }
      char cmdb[RFCTL_UART_CMD_LEN + 1], v[16];
      int len = rfctl_uart_format(c->value[i], cmdb, sizeof cmdb);
      uint32_t lat = 0;
      int r = rfctl_hal_uart_txn(d->aux, (uint8_t)(d->line[0] & 0xff), cmdb, (uint8_t)len, 50000u, &lat);
      rfctl_format_value(d, c->value[i], v, sizeof v);
      const char *res = r == 1 ? "ok" : r == 0 ? "timeout" : r == -1 ? "stuck_low" : "absent";
      out(c, tag, "att %s %s value=%s latency_us=%u", d->name, res, v, (unsigned)(r == 1 ? lat : 0));
      n++;
      good += r == 1;
    }
    out(c, tag, "ok attcheck n=%u ok=%u fail=%u", n, good, n - good);
  } else if (!strcmp(cmd, "bootsel")) {
    rfctl_apply_safe(c);
    out(c, tag, "ok bootsel");
    rfctl_hal_bootsel();
  } else if (!strcmp(cmd, "reset")) {
    rfctl_apply_safe(c);
    out(c, tag, "ok reset");
    rfctl_hal_reset();
  } else {
    out(c, tag, "err unknown_cmd %s", cmd);
  }
}

void rfctl_feed(rfctl *c, const char *bytes, size_t n) {
  for (size_t i = 0; i < n; i++) {
    char ch = bytes[i];
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (c->line_overflow) {
        out(c, NULL, "err line_too_long max=%u", (unsigned)(RFCTL_LINE_MAX - 1));
      } else {
        c->line_buf[c->line_len] = 0;
        rfctl_exec(c, c->line_buf);
      }
      c->line_len = 0;
      c->line_overflow = false;
      continue;
    }
    if (c->line_len < RFCTL_LINE_MAX - 1) c->line_buf[c->line_len++] = ch;
    else c->line_overflow = true;
  }
}

void rfctl_init(rfctl *c, const rfctl_board *b, rfctl_write_fn w, void *ctx) {
  memset(c, 0, sizeof *c);
  c->board = b;
  c->write = w;
  c->write_ctx = ctx;
  c->lease_deadline = -1;
  c->late_limit_us = 50;
  c->cap_holdoff_us = 2000;
  rfctl_apply_safe(c);
}
