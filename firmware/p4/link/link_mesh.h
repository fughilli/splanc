// The front end's half of mesh time on a P4 + C6 lamp (docs/design/mesh.md §8.2, §10.2):
// the C6 runs the mesh and maps its show epoch onto a time base (main.cpp lm_mesh_tb on a
// C6 player), but the P4 renders, on its own clock. Two pieces, dependency-free so they
// are host-tested (link_mesh_test.cc):
//
//   lk_clock  the C6 <-> P4 clock offset from LK_OP_TIME pings over the link: the fastest
//             round trip of the recent ones (its asymmetry error is at most half of it).
//   lk_tb     the time base as the mesh layer sees it, in the C6's clock, mirrored onto the
//             P4 as LK_OP_TIMEBASE (the P4's clock). The mesh reads and writes it from its
//             tick without touching the link; relay_main.cpp sends what lk_tb_take builds.
//             A time base the app set on the P4 (set_time_base, forwarded there) comes back
//             in the P4's HEARTBEAT and shows up here as a change, which the mesh treats as
//             it does on a C6 player (a new generation from the gateway's session, else the
//             mesh's epoch wins again).
#ifndef FIRMWARE_P4_LINK_LINK_MESH_H_
#define FIRMWARE_P4_LINK_LINK_MESH_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "firmware/p4/link/link_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

// -- lk_clock -------------------------------------------------------------------------------

enum {
  LK_CLOCK_SAMPLES = 8,
};
// Samples older than this are forgotten; a round trip slower than this is no sample.
#define LK_CLOCK_MAX_AGE_US (20LL * 1000 * 1000)
#define LK_CLOCK_MAX_RTT_US 20000

typedef struct {
  int64_t off_us[LK_CLOCK_SAMPLES];  // P4 clock - C6 clock
  int64_t at_us[LK_CLOCK_SAMPLES];   // when it was taken (C6 clock)
  int32_t rtt_us[LK_CLOCK_SAMPLES];
  uint8_t n, next;
  uint32_t samples, rejected;
} lk_clock;

static inline void lk_clock_init(lk_clock *c) {
  c->n = c->next = 0;
  c->samples = c->rejected = 0;
}

// A ping sent at t0 (C6), stamped t_p4 by the P4, its answer seen at t1 (C6).
static inline void lk_clock_sample(lk_clock *c, int64_t t0, int64_t t_p4, int64_t t1) {
  const int64_t rtt = t1 - t0;
  if (rtt < 0 || rtt > LK_CLOCK_MAX_RTT_US) {
    c->rejected++;
    return;
  }
  c->off_us[c->next] = t_p4 - (t0 + rtt / 2);
  c->at_us[c->next] = t1;
  c->rtt_us[c->next] = (int32_t)rtt;
  c->next = (uint8_t)((c->next + 1) % LK_CLOCK_SAMPLES);
  if (c->n < LK_CLOCK_SAMPLES) c->n++;
  c->samples++;
}

// The offset (P4 = C6 + *off_us) from the fastest recent round trip: false while there is none.
static inline bool lk_clock_offset(const lk_clock *c, int64_t now_us, int64_t *off_us, int32_t *rtt_us) {
  int best = -1;
  for (int i = 0; i < c->n; i++) {
    if (now_us - c->at_us[i] > LK_CLOCK_MAX_AGE_US) continue;
    if (best < 0 || c->rtt_us[i] < c->rtt_us[best]) best = i;
  }
  if (best < 0) return false;
  *off_us = c->off_us[best];
  if (rtt_us) *rtt_us = c->rtt_us[best];
  return true;
}

static inline int64_t lk_round_ms(int64_t us) { return us >= 0 ? (us + 500) / 1000 : -((-us + 500) / 1000); }

// -- lk_tb ----------------------------------------------------------------------------------

// The offset may move this far (µs) from the one the P4's time base was converted with
// before it is re-sent (hysteresis around the 1 ms rounding).
#define LK_TB_DRIFT_US 750
// A TIMEBASE the P4 has not echoed in this long is sent again (a frame dropped on the link).
#define LK_TB_RESEND_US (300LL * 1000)

typedef struct {
  bool synced;  // adopted the P4's state since it came up (else the mesh is told "busy")
  bool set, align;
  int64_t epoch_ms;     // the time base, the C6's clock
  bool dirty;           // changed since the last TIMEBASE
  int32_t shift_total;  // the running shift sum (lk_timebase)
  uint16_t seq;         // of the last TIMEBASE built
  uint16_t acked;       // the last one the P4 applied (its HEARTBEAT)
  bool sent_set;        // the last TIMEBASE had a time base
  int64_t sent_off_ms;  // the offset it was converted with
  int64_t sent_at_us;
  lk_timebase last;  // for a resend
  uint32_t app_changes, resends, drifts;
} lk_tb;

// The P4 went down (or this is boot, on a zeroed lk_tb): wait for its state again. The
// counters (app_changes, resends, drifts) are kept.
static inline void lk_tb_reset(lk_tb *t) {
  t->synced = false;
  t->set = t->align = t->dirty = t->sent_set = false;
  t->epoch_ms = 0;
  t->shift_total = 0;
  t->seq = t->acked = 0;
  t->sent_off_ms = 0;
  t->sent_at_us = 0;
}

// main.cpp lm_mesh_tb's contract (op 0 get, 1 put, 2 clear, 3 align), -1 = busy (not synced
// with the P4 yet: the mesh asks again).
static inline int32_t lk_tb_op(lk_tb *t, int32_t op, int64_t *epoch_ms, int64_t shift_ms) {
  if (!t->synced) return -1;
  switch (op) {
    case 0:
      *epoch_ms = t->set ? t->epoch_ms : 0;
      return t->set ? 1 : 0;
    case 1:
      if (!t->set || t->epoch_ms != *epoch_ms || shift_ms != 0) t->dirty = true;
      t->set = true;
      t->epoch_ms = *epoch_ms;
      t->shift_total += (int32_t)shift_ms;
      return 1;
    case 2:
      if (t->set) t->dirty = true;
      t->set = false;
      t->epoch_ms = 0;
      return 1;
    case 3:
      if (t->align != (*epoch_ms != 0)) t->dirty = true;
      t->align = *epoch_ms != 0;
      return 1;
    default:
      return 0;
  }
}

// The P4's HEARTBEAT (with its extension), `off_ms` the current offset. The first one after
// the P4 came up (lk_tb_reset on its down edge) is adopted as it stands; later ones only
// matter once the P4 has applied our last TIMEBASE: a difference then is the app's.
static inline void lk_tb_status(lk_tb *t, const lk_status *s, int64_t off_ms) {
  if (!s->has_ext) return;
  const bool pset = (s->tb_flags & LK_TB_SET) != 0;
  if (!t->synced) {
    t->synced = true;
    t->set = pset;
    t->align = (s->tb_flags & LK_TB_ALIGN) != 0;
    t->epoch_ms = pset ? s->tb_epoch_ms - off_ms : 0;
    t->shift_total = s->tb_shift_total;
    t->seq = t->acked = s->tb_seq;
    t->sent_set = pset;
    t->sent_off_ms = off_ms;
    t->dirty = false;
    return;
  }
  t->acked = s->tb_seq;
  if (t->dirty || s->tb_seq != t->seq) return;  // ours is not applied yet
  const int64_t pe = pset ? s->tb_epoch_ms - t->sent_off_ms : 0;
  if (pset != t->set || (pset && pe != t->epoch_ms)) {
    t->set = pset;
    t->epoch_ms = pe;
    t->sent_set = pset;
    t->app_changes++;
  }
}

// The TIMEBASE to send now, if any (into *out): a change, the offset moved past
// LK_TB_DRIFT_US, or the last one not echoed in LK_TB_RESEND_US.
static inline bool lk_tb_take(lk_tb *t, int64_t now_us, int64_t off_us, lk_timebase *out) {
  if (!t->synced) return false;
  const int64_t off_ms = lk_round_ms(off_us);
  int64_t moved = off_us - t->sent_off_ms * 1000;
  if (moved < 0) moved = -moved;
  const bool drift = t->set && t->sent_set && moved > LK_TB_DRIFT_US && off_ms != t->sent_off_ms;
  if (t->dirty || drift) {
    // The P4's epoch moves with the offset: its queued changes move the same.
    if (t->set && t->sent_set) t->shift_total += (int32_t)(off_ms - t->sent_off_ms);
    if (drift && !t->dirty) t->drifts++;
    t->seq++;
    t->last.seq = t->seq;
    t->last.flags = (uint16_t)((t->set ? LK_TB_SET : 0) | (t->align ? LK_TB_ALIGN : 0));
    t->last.epoch_ms = t->set ? t->epoch_ms + off_ms : 0;
    t->last.shift_total = t->shift_total;
    t->sent_set = t->set;
    t->sent_off_ms = off_ms;
    t->sent_at_us = now_us;
    t->dirty = false;
    *out = t->last;
    return true;
  }
  if (t->acked != t->seq && now_us - t->sent_at_us >= LK_TB_RESEND_US) {
    t->sent_at_us = now_us;
    t->resends++;
    *out = t->last;
    return true;
  }
  return false;
}

// -- the P4's half --------------------------------------------------------------------------

// The P4 applies a TIMEBASE once (by seq): the shift its queued changes take is the
// difference of shift totals. False: a repeat, nothing to do.
typedef struct {
  uint16_t seq;
  int32_t shift_total;
} lk_tb_applied;

static inline bool lk_tb_apply_shift(lk_tb_applied *a, const lk_timebase *t, int32_t *shift_ms) {
  if (t->seq == a->seq) return false;
  *shift_ms = (int32_t)((uint32_t)t->shift_total - (uint32_t)a->shift_total);
  a->seq = t->seq;
  a->shift_total = t->shift_total;
  return true;
}

#ifdef __cplusplus
}
#endif

#endif  // FIRMWARE_P4_LINK_LINK_MESH_H_
