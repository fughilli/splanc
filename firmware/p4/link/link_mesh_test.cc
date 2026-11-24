// Host tests for the front end's mesh time on a P4 + C6 lamp (link_mesh.h): the clock
// offset filter, the time-base mirror the mesh reads and writes from its tick, and the
// P4's once-only apply of a TIMEBASE.
#include "firmware/p4/link/link_mesh.h"

#include <cassert>
#include <cstdint>
#include <cstring>

#include "rr_case.h"

// The fastest round trip wins: its offset is the truest (asymmetry <= rtt / 2).
static void test_clock_min_rtt() {
  lk_clock c;
  lk_clock_init(&c);
  int64_t off = 0;
  int32_t rtt = 0;
  assert(!lk_clock_offset(&c, 0, &off, &rtt));
  // True offset +1,000,000 µs. A slow sample (P4 answered late: 4 ms one way) ...
  lk_clock_sample(&c, 1000, 1000 + 1000000 + 4000, 1000 + 5000);
  assert(lk_clock_offset(&c, 6000, &off, &rtt) && rtt == 5000 && off == 1000000 + 1500);
  // ... then a fast one.
  lk_clock_sample(&c, 10000, 10000 + 1000000 + 300, 10000 + 600);
  assert(lk_clock_offset(&c, 11000, &off, &rtt) && rtt == 600 && off == 1000000);
  // Too slow to be a sample, or time running backwards: rejected.
  lk_clock_sample(&c, 20000, 0, 20000 + LK_CLOCK_MAX_RTT_US + 1);
  lk_clock_sample(&c, 20000, 0, 19999);
  assert(c.rejected == 2 && c.samples == 2);
  // Samples age out: the slow one is younger than the fast one here, but both go.
  assert(!lk_clock_offset(&c, 10600 + LK_CLOCK_MAX_AGE_US + 1, &off, &rtt));
  // The ring keeps the last LK_CLOCK_SAMPLES.
  for (int i = 0; i < 20; i++) lk_clock_sample(&c, 100000 + i * 1000, 100000 + i * 1000 + 7 + 50 * i, 100000 + i * 1000 + 100 * i + 10);
  assert(c.n == LK_CLOCK_SAMPLES);
  assert(lk_clock_offset(&c, 200000, &off, &rtt) && rtt == 100 * 12 + 10);
  assert(lk_round_ms(1499) == 1 && lk_round_ms(1500) == 2 && lk_round_ms(-1500) == -2 && lk_round_ms(-1499) == -1);
}

static lk_status hb(bool set, int64_t epoch, uint16_t seq, int32_t total, bool align = false) {
  lk_status s = {};
  s.has_ext = true;
  s.tb_flags = (uint16_t)((set ? LK_TB_SET : 0) | (align ? LK_TB_ALIGN : 0));
  s.tb_epoch_ms = epoch;
  s.tb_seq = seq;
  s.tb_shift_total = total;
  return s;
}

// The mesh's view: busy until the P4's state is adopted, then puts go out as TIMEBASE in the
// P4's clock, once, and come back echoed.
static void test_tb_mirror() {
  lk_tb t = {};  // the counters are zeroed once; lk_tb_reset keeps them
  lk_tb_reset(&t);
  int64_t e = 0;
  lk_timebase m;
  assert(lk_tb_op(&t, 0, &e, 0) == -1 && !lk_tb_take(&t, 0, 0, &m));
  // A step-2 P4 (no extension) never syncs: the mesh keeps being told "busy".
  lk_status old = {};
  lk_tb_status(&t, &old, 0);
  assert(!t.synced);
  // The P4 is up with no time base, offset P4 = C6 + 5000.4 ms.
  const int64_t off_us = 5000400, off_ms = 5000;
  lk_status s = hb(false, 0, 41, 9);
  lk_tb_status(&t, &s, off_ms);
  assert(t.synced && lk_tb_op(&t, 0, &e, 0) == 0);
  assert(!lk_tb_take(&t, 0, off_us, &m));
  // The mesh maps its epoch here (C6 ms 1000) and aligns frames to it.
  e = 1000;
  assert(lk_tb_op(&t, 1, &e, 0) == 1);
  int64_t one = 1;
  assert(lk_tb_op(&t, 3, &one, 0) == 1);
  assert(lk_tb_take(&t, 100, off_us, &m));
  assert(m.seq == 42 && m.flags == (LK_TB_SET | LK_TB_ALIGN) && m.epoch_ms == 6000 && m.shift_total == 9);
  assert(!lk_tb_take(&t, 200, off_us, &m));
  // Not echoed: the same TIMEBASE again after LK_TB_RESEND_US.
  assert(lk_tb_take(&t, 100 + LK_TB_RESEND_US, off_us, &m) && m.seq == 42 && t.resends == 1);
  // A heartbeat from before the P4 applied it changes nothing (still the old state there).
  s = hb(false, 0, 41, 9);
  lk_tb_status(&t, &s, off_ms);
  assert(lk_tb_op(&t, 0, &e, 0) == 1 && e == 1000);
  // Echoed.
  s = hb(true, 6000, 42, 9, true);
  lk_tb_status(&t, &s, off_ms);
  assert(!lk_tb_take(&t, 900000, off_us, &m));
  // Mesh time slews 2 ms: the epoch moves, and so do the queued changes (shift 2).
  e = 1002;
  assert(lk_tb_op(&t, 1, &e, 2) == 1);
  assert(lk_tb_take(&t, 1000000, off_us, &m) && m.seq == 43 && m.epoch_ms == 6002 && m.shift_total == 11);
  s = hb(true, 6002, 43, 11, true);
  lk_tb_status(&t, &s, off_ms);
  // The C6 <-> P4 offset moves under 0.75 ms: nothing; past it, the P4's epoch follows (and
  // its queued changes, by the whole ms).
  assert(!lk_tb_take(&t, 2000000, 5000700, &m));
  assert(lk_tb_take(&t, 2000000, 5000800, &m) && m.seq == 44 && m.epoch_ms == 6003 && m.shift_total == 12);
  assert(t.drifts == 1);
  s = hb(true, 6003, 44, 12, true);
  lk_tb_status(&t, &s, 5001);
  assert(lk_tb_op(&t, 0, &e, 0) == 1 && e == 1002);
  // The app's set_time_base on the P4 (P4 ms 9000): a change the mesh sees, in its clock.
  s = hb(true, 9000, 44, 12, true);
  lk_tb_status(&t, &s, 5001);
  assert(lk_tb_op(&t, 0, &e, 0) == 1 && e == 3999 && t.app_changes == 1);
  assert(!lk_tb_take(&t, 3000000, 5000800, &m));
  // The mesh clears it (left the mesh): a TIMEBASE without one.
  assert(lk_tb_op(&t, 2, &e, 0) == 1);
  assert(lk_tb_take(&t, 4000000, 5000800, &m) && !(m.flags & LK_TB_SET) && m.epoch_ms == 0 && m.shift_total == 12);
  // The P4 went down: busy until its state is adopted again (it rebooted: seq 0, nothing).
  lk_tb_reset(&t);
  assert(lk_tb_op(&t, 0, &e, 0) == -1);
  s = hb(false, 0, 0, 0);
  lk_tb_status(&t, &s, 5001);
  assert(lk_tb_op(&t, 0, &e, 0) == 0);
  e = 1500;
  assert(lk_tb_op(&t, 1, &e, 0) == 1 && lk_tb_take(&t, 5000000, 5000800, &m) && m.seq == 1 && m.shift_total == 0);
}

// The P4 applies each TIMEBASE once; a repeat (the resend of one it had) shifts nothing.
static void test_p4_apply_once() {
  lk_tb_applied a = {0, 0};
  lk_timebase t = {1, LK_TB_SET, 6000, 9};
  int32_t sh = 0;
  assert(lk_tb_apply_shift(&a, &t, &sh) && sh == 9);
  assert(!lk_tb_apply_shift(&a, &t, &sh));
  t = {2, LK_TB_SET, 6002, 11};
  assert(lk_tb_apply_shift(&a, &t, &sh) && sh == 2);
  // Two lost in between: the shifts add up.
  t = {5, LK_TB_SET, 6010, 20};
  assert(lk_tb_apply_shift(&a, &t, &sh) && sh == 9);
  // Wrapping totals still give the difference.
  a.shift_total = INT32_MAX;
  t = {6, LK_TB_SET, 6010, INT32_MIN};
  assert(lk_tb_apply_shift(&a, &t, &sh) && sh == 1);
}

int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "link_mesh",
                      {
                          {"clock_min_rtt", test_clock_min_rtt},
                          {"tb_mirror", test_tb_mirror},
                          {"p4_apply_once", test_p4_apply_once},
                      });
}
