// See tracker_service.h. The task loop is the bring-up image's (tracker.cpp) without
// its console prints: attach, handshake, then feed every report to lh_report.
#include "firmware/p4/tracker/tracker_service.h"

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <freertos/task.h>
#include <stdio.h>
#include <string.h>

#include "firmware/p4/tracker/lh_p4.h"
#include "firmware/p4/tracker/usb_tracker.h"


// ---------------------------------------------------------------- raw recording
//
// Batches (one UDP datagram each, <= kBatchMax):
//   "\0LHD" | seq u32 LE | records...
//   'F' set u8 | rtn i16 LE | len u8 | us i64 LE | data[len]     a feature exchange
//   'R' iface u8 | len u8 | us i64 LE | data[len]                 an input report
//   'D' count u32 LE                                              records dropped here
// The leading NUL tells them from console text on the same channel; seq shows UDP loss.
//
// The tracker task only copies records into a ring (never blocks: a full ring drops the
// record and counts it); a low-priority sender task packs the batches and sends them,
// paced, so recording neither slows the tracker nor bursts the radio.
extern "C" bool lm_dump_send(const uint8_t *data, size_t len);  // link_transport.cpp

namespace {
constexpr size_t kBatchMax = 1400;
constexpr size_t kRingCap = 128 * 1024;  // ~2 s of reports at full rate
constexpr int64_t kRecordHoldUs = 15 * 1000 * 1000;
constexpr TickType_t kPace = pdMS_TO_TICKS(4);      // at most one datagram per 4 ms
constexpr TickType_t kMaxWait = pdMS_TO_TICKS(50);  // a part-filled batch waits at most this
volatile int64_t g_record_until_us = 0;  // set by tracker_service_record (any task)
bool g_recording = false;                // tracker task
uint8_t *g_ring = nullptr;               // PSRAM
volatile size_t g_ring_head = 0, g_ring_tail = 0;  // producer: tracker task; consumer: sender
volatile uint32_t g_rec_dropped = 0;
uint32_t g_rec_sent = 0, g_rec_unsent = 0, g_seq = 0;

size_t ring_used() { return (g_ring_head - g_ring_tail) % kRingCap; }

// Tracker task: one whole record (its first byte is its type; lengths follow the format).
void rec_put(const uint8_t *rec, size_t n) {
  if (!g_ring || n + 1 >= kRingCap - ring_used()) {
    g_rec_dropped = g_rec_dropped + 1;
    return;
  }
  size_t h = g_ring_head;
  for (size_t i = 0; i < n; i++) g_ring[(h + i) % kRingCap] = rec[i];
  g_ring_head = (h + n) % kRingCap;
}

// Length of the record at ring offset `t` (its header is in the ring).
size_t rec_len_at(size_t t) {
  const uint8_t k = g_ring[t % kRingCap];
  if (k == 'R') return 11 + g_ring[(t + 2) % kRingCap];
  if (k == 'F') return 13 + g_ring[(t + 4) % kRingCap];
  return 5;  // 'D'
}

void rec_sender(void *) {
  static uint8_t batch[kBatchMax];
  uint32_t reported_drops = 0;
  TickType_t last = xTaskGetTickCount();
  for (;;) {
    vTaskDelay(kPace);
    // A full batch, or what there is after kMaxWait: ~30 datagrams/s at the full report
    // rate, not one per tick.
    if (ring_used() == 0) continue;
    if (ring_used() < kBatchMax - 16 && xTaskGetTickCount() - last < kMaxWait) continue;
    last = xTaskGetTickCount();
    memcpy(batch, "\0LHD", 4);
    memcpy(batch + 4, &g_seq, 4);
    size_t n = 8;
    const uint32_t drops = g_rec_dropped;
    if (drops != reported_drops) {
      batch[n] = 'D';
      memcpy(batch + n + 1, &drops, 4);
      n += 5;
      reported_drops = drops;
    }
    while (ring_used() > 0) {
      const size_t t = g_ring_tail, len = rec_len_at(t);
      if (n + len > kBatchMax) break;
      for (size_t i = 0; i < len; i++) batch[n + i] = g_ring[(t + i) % kRingCap];
      n += len;
      g_ring_tail = (t + len) % kRingCap;
    }
    if (lm_dump_send(batch, n)) {
      g_rec_sent++;
    } else {
      g_rec_unsent++;
    }
    g_seq++;
  }
}

void rec_report(const TrackerReport &r) {
  uint8_t b[11 + 64];
  b[0] = 'R';
  b[1] = r.iface;
  b[2] = r.len;
  memcpy(b + 3, &r.us, 8);
  memcpy(b + 11, r.data, r.len);
  rec_put(b, 11 + r.len);
}

void rec_log(const char *fmt, unsigned a, unsigned b, unsigned c) {
  char m[128];
  const int n = snprintf(m, sizeof m, fmt, a, b, c);
  p4_log(reinterpret_cast<const uint8_t *>(m), n > 0 ? (size_t)n : 0);
}

// Tracker task: start / stop as asked.
void rec_features() {
  for (size_t i = 0; i < tracker_feature_count(); i++) {
    const TrackerFeature *f = tracker_feature(i);
    uint8_t b[13 + 72];
    b[0] = 'F';
    b[1] = f->set;
    memcpy(b + 2, &f->rtn, 2);
    b[4] = f->len;
    memcpy(b + 5, &f->us, 8);
    memcpy(b + 13, f->data, f->len);
    rec_put(b, 13 + f->len);
  }
}

void rec_tick(int64_t now) {
  const bool want = now < g_record_until_us;
  // The feature exchanges again every 10 s: a recorder that lost them (UDP) or joined
  // late still gets the handshake the replay needs (it keeps one copy).
  static int64_t features_us = 0;
  if (want && g_recording && now - features_us >= 10 * 1000 * 1000) {
    features_us = now;
    rec_features();
  }
  if (want && !g_recording) {
    features_us = now;
    if (!g_ring) {
      g_ring = static_cast<uint8_t *>(heap_caps_malloc(kRingCap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
      if (!g_ring) return;
      xTaskCreatePinnedToCore(rec_sender, "lhrec", 3072, nullptr, 2, nullptr, 1);
    }
    g_recording = true;
    g_rec_sent = g_rec_unsent = 0;
    g_rec_dropped = 0;
    rec_features();
    rec_log("[tracker] recording to the log subscriber (%u feature exchanges, ring %u KB, pace %u ms)", (unsigned)tracker_feature_count(), (unsigned)(kRingCap / 1024), 4);
  } else if (!want && g_recording) {
    g_recording = false;
    rec_log("[tracker] recording stopped: %u batches sent, %u not, %u records dropped (ring full)", g_rec_sent,
            g_rec_unsent, g_rec_dropped);
  }
}
}  // namespace

void tracker_service_record() { g_record_until_us = esp_timer_get_time() + kRecordHoldUs; }

namespace {

QueueHandle_t g_reports;
struct Adopt {
  uint32_t id;
  float p[7];
};
QueueHandle_t g_adopt;
portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
TrackerPose g_pose = {};
// How far behind the tracker task runs: a report's age when the kernel gets it.
uint32_t g_lag_us = 0, g_lag_max_us = 0, g_depth_max = 0, g_skipped = 0;
// While not tracking, a backlog beyond this many reports (~1 ms each) is stale: the oldest
// are dropped down to kBacklogKeep, so a failed pose bootstrap (~0.6 s of CPU here) doesn't
// leave the next one further behind. While tracking it is worked off instead: the backlog
// after a successful bootstrap is the light the new track needs (0.6 s costs ~0.1 s to
// catch up). Skipping it handed the fresh track a hole: it coasted across it and was lost
// at once (Drifted), or the sweep timing lost its lock (Silence), every attempt; ~15 s
// without a lock on PixieLamp2 (2026-11-13). Only a nearly full queue is cut then.
constexpr UBaseType_t kBacklogMax = 48, kBacklogKeep = 8, kBacklogTrackingMax = 900;
// The profile, taken from lh_profile once a second on this task and summed here until
// tracker_service_profile collects it.
LhProfile g_profile = {};
// tracker_service_stream's request (-1 none), applied on this task.
volatile int g_stream_req = -1;

void publish(const LhStatus& s) {
  TrackerPose p;
  p.configured = s.configured;
  p.tracking = s.tracking;
  p.clock_ok = s.clock_ok;
  p.stations = s.stations;
  p.t = (float)s.t;
  memcpy(p.pos, s.pos, sizeof p.pos);
  memcpy(p.quat, s.quat, sizeof p.quat);
  memcpy(p.vel, s.vel, sizeof p.vel);
  memcpy(p.accel, s.accel, sizeof p.accel);
  memcpy(p.omega, s.omega, sizeof p.omega);
  p.pose_us = s.pose_us;
  p.light_us = s.light_us;
  p.trigger_us = s.trigger_us;
  p.ready_us = s.ready_us;
  p.poses = s.poses;
  p.imu = s.imu;
  p.pulses = s.pulses;
  p.sweeps = s.sweeps;
  p.sweep_parts = s.sweep_parts;
  p.late_pulses = s.late_pulses;
  p.light_margin_us = s.light_margin_us;
  p.streaming = s.streaming;
  p.health = s.health;
  p.pos_sigma = s.pos_sigma;
  p.starts = s.starts;
  p.losses = s.losses;
  p.coasts = s.coasts;
  p.speculative = s.speculative;
  taskENTER_CRITICAL(&g_mux);
  const bool fresh = s.poses != g_pose.poses;
  p.seq = g_pose.seq + (fresh ? 1 : 0);
  p.published_us = fresh ? esp_timer_get_time() : g_pose.published_us;
  g_pose = p;
  taskEXIT_CRITICAL(&g_mux);
}

void take_profile() {
  LhProfile p;
  lh_profile(&p);
  taskENTER_CRITICAL(&g_mux);
  for (int k = 0; k < 4; k++) {
    g_profile.n[k] += p.n[k];
    g_profile.cycles[k] += p.cycles[k];
    if (p.max_cycles[k] > g_profile.max_cycles[k]) g_profile.max_cycles[k] = p.max_cycles[k];
  }
  g_profile.light_reports += p.light_reports;
  g_profile.light_late_sum_us += p.light_late_sum_us;
  if (p.light_late_max_us > g_profile.light_late_max_us) g_profile.light_late_max_us = p.light_late_max_us;
  taskEXIT_CRITICAL(&g_mux);
}

int g_prio = 0, g_tracking_prio = 0;

void task(void*) {
  uint16_t vid = 0, pid = 0;
  bool high = false;
  bool open = false, configured = false;
  while (true) {
    if (!open && tracker_usb_open(&vid, &pid)) {
      open = true;
      configured = false;
      if (lh_attach(vid, pid) == 1) tracker_usb_stream();
    }
    if (open && tracker_usb_gone()) {
      lh_detach();
      tracker_usb_close();
      open = configured = false;
    }
    if (open && !configured) {
      configured = lh_handshake() == 0;
      if (!configured) vTaskDelay(pdMS_TO_TICKS(500));
    }
    Adopt a;
    while (configured && xQueueReceive(g_adopt, &a, 0) == pdTRUE) lh_station_prior(a.id, a.p);
    if (g_stream_req >= 0) {
      lh_set_stream(g_stream_req);
      g_stream_req = -1;
    }
    TrackerReport r;
    // Wait for the first report, then take only what is queued (one arrives every ~1 ms),
    // at most a batch: publish between batches, or a backlog (after anything slow on this
    // task) is worked off with no pose out until the queue is empty.
    if (uxQueueMessagesWaiting(g_reports) > (high ? kBacklogTrackingMax : kBacklogMax)) {
      uint32_t k = 0;
      while (uxQueueMessagesWaiting(g_reports) > kBacklogKeep && xQueueReceive(g_reports, &r, 0) == pdTRUE) k++;
      taskENTER_CRITICAL(&g_mux);
      g_skipped += k;
      taskEXIT_CRITICAL(&g_mux);
    }
    bool any = false;
    int n = 0;
    // Wait at most a tick (1 ms) for the first: between reports the kernel still gets the
    // clock (lh_clock below), which sends a sweep as soon as the laser has passed.
    for (TickType_t wait = 1; n < 16 && xQueueReceive(g_reports, &r, wait) == pdTRUE; wait = 0) {
      const uint32_t depth = uxQueueMessagesWaiting(g_reports);
      const uint32_t lag = (uint32_t)(esp_timer_get_time() - r.us);
      taskENTER_CRITICAL(&g_mux);
      g_lag_us = lag;
      if (lag > g_lag_max_us) g_lag_max_us = lag;
      if (depth > g_depth_max) g_depth_max = depth;
      taskEXIT_CRITICAL(&g_mux);
      if (g_recording) rec_report(r);
      lh_report(r.iface, r.data, r.len, r.us);
      any = true;
      n++;
    }
    rec_tick(esp_timer_get_time());
    if (configured) lh_clock(esp_timer_get_time());
    if (configured || any || !open) {
      LhStatus s;
      lh_status(&s);
      publish(s);
      // Above render while tracking; back down as soon as it isn't (the next sweep may
      // start a bootstrap).
      if ((s.tracking != 0) != high) {
        high = s.tracking != 0;
        vTaskPrioritySet(nullptr, high ? g_tracking_prio : g_prio);
      }
    }
    static int64_t last_profile_us = 0;
    const int64_t now = esp_timer_get_time();
    if (now - last_profile_us >= 1000000) {
      last_profile_us = now;
      take_profile();
    }
  }
}

}  // namespace

void tracker_service_start(int prio, int tracking_prio, int usb_prio, int core) {
  g_prio = prio;
  g_tracking_prio = tracking_prio;
  g_reports = xQueueCreate(1024, sizeof(TrackerReport));
  g_adopt = xQueueCreate(8, sizeof(Adopt));
  tracker_usb_start(g_reports, usb_prio);
  // The kernel's EKF and calibration run on this task: a big stack.
  xTaskCreatePinnedToCore(task, "tracker", 32 * 1024, nullptr, prio, nullptr, core);
}

void tracker_service_get(TrackerPose* out) {
  taskENTER_CRITICAL(&g_mux);
  *out = g_pose;
  taskEXIT_CRITICAL(&g_mux);
}

void tracker_service_lag(TrackerLag* out) {
  taskENTER_CRITICAL(&g_mux);
  out->last_us = g_lag_us;
  out->max_us = g_lag_max_us;
  out->depth_max = g_depth_max;
  out->skipped = g_skipped;
  g_lag_max_us = g_depth_max = 0;
  taskEXIT_CRITICAL(&g_mux);
  out->dropped = tracker_usb_dropped();
}

void tracker_service_profile(LhProfile* out) {
  taskENTER_CRITICAL(&g_mux);
  *out = g_profile;
  g_profile = {};
  taskEXIT_CRITICAL(&g_mux);
}

void tracker_service_stream(bool on) { g_stream_req = on ? 1 : 0; }

void tracker_service_adopt(uint32_t id, const float p[7]) {
  if (!g_adopt) return;
  Adopt a = {id, {}};
  memcpy(a.p, p, sizeof a.p);
  xQueueSend(g_adopt, &a, 0);  // full (a burst): lhd sends again in a second
}
